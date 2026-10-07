import http from 'node:http'
import type { AddressInfo } from 'node:net'

import { QueueEvents } from 'bullmq'
import { getPayload, type Payload } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import config from '@payload-config'
import { addOrgMembership } from '@/access/memberships'
import type { Role } from '@/access/permissions'
import { POST as adhocCheck } from '@/app/api/orgs/[orgId]/checks/route'
import { POST as checkNow } from '@/app/api/orgs/[orgId]/monitors/[id]/check/route'
import { env, resetEnvCache } from '@/env'
import type { OnDemandCheckResult } from '@/lib/on-demand-check'
import { defaultMonitorValues } from '@/lib/validation/monitor'
import type { Monitor, Organization, User } from '@/payload-types'
import {
  createQueue,
  OnDemandSkipError,
  processManualCheckJob,
  QUEUE_NAMES,
  setOnDemandTransport,
  startCheckWorker,
  type ChecksQueue,
} from '@/server/engine'
import { createRedis } from '@/server/redis'
import { onDemandCheckLimiter } from '@/server/security/limiters'

/**
 * On-demand checks (#98): "Check now" (`POST /api/orgs/:orgId/monitors/:id/check`) and ad-hoc tests
 * of unsaved configurations (`POST /api/orgs/:orgId/checks`), run by a real BullMQ worker on a
 * queue with a random prefix.
 */

let payload: Payload
const run = Date.now().toString(36)
const email = (name: string) => `${name}+odc-${run}@marmot.test`
const PASSWORD = 'password-123'

type Session = { user: User; cookie: string }

async function createMember(name: string, org: Organization, role: Role): Promise<Session> {
  const user = await payload.create({
    collection: 'users',
    data: { email: email(name), password: PASSWORD, name },
  })
  await addOrgMembership({ payload, userId: user.id, orgId: org.id, role })
  const { token } = await payload.login({
    collection: 'users',
    data: { email: email(name), password: PASSWORD },
  })
  return { user, cookie: `payload-token=${token}` }
}

function request(path: string, body?: unknown, session?: Session): Request {
  return new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: {
      Origin: env.NEXT_PUBLIC_SERVER_URL,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(session ? { cookie: session.cookie } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
}

const monitorParams = (orgId: string | number, id: string | number) => ({
  params: Promise.resolve({ orgId: String(orgId), id: String(id) }),
})
const orgParams = (orgId: string | number) => ({
  params: Promise.resolve({ orgId: String(orgId) }),
})

let server: http.Server
let baseUrl: string
let orgA: Organization
let orgB: Organization
let member: Session
let viewer: Session
let outsider: Session
let queue: ChecksQueue
let events: QueueEvents
let worker: ReturnType<typeof startCheckWorker>
const prefix = `marmot-test-odc-${Math.random().toString(36).slice(2, 10)}`

async function createMonitor(data: Partial<Monitor> & { name: string }, org = orgA) {
  return (await payload.create({
    collection: 'monitors',
    overrideAccess: true,
    depth: 0,
    data: {
      type: 'http',
      url: `${baseUrl}/ok`,
      interval: 60,
      retryInterval: 60,
      maxRetries: 0,
      timeout: 5,
      ...data,
      organization: org.id,
    } as never,
  })) as Monitor
}

const heartbeatsOf = async (monitorId: string | number) =>
  (
    await payload.find({
      collection: 'heartbeats',
      where: { monitor: { equals: monitorId } },
      depth: 0,
      limit: 100,
      pagination: false,
    })
  ).docs

const httpConfig = (path: string) => ({
  ...defaultMonitorValues('http'),
  name: 'unsaved',
  url: `${baseUrl}${path}`,
  timeout: 5,
})

describe('on-demand checks', () => {
  beforeAll(async () => {
    payload = await getPayload({ config })
    server = http.createServer((req, res) => {
      res.statusCode = req.url === '/fail' ? 500 : 200
      res.end('hello')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

    orgA = await payload.create({
      collection: 'organizations',
      data: { name: 'ODC A', slug: `odc-a-${run}` },
    })
    orgB = await payload.create({
      collection: 'organizations',
      data: { name: 'ODC B', slug: `odc-b-${run}` },
    })
    member = await createMember('member', orgA, 'member')
    viewer = await createMember('viewer', orgA, 'viewer')
    outsider = await createMember('outsider', orgB, 'owner')

    queue = createQueue(QUEUE_NAMES.checks, { prefix })
    events = new QueueEvents(QUEUE_NAMES.checks, { connection: createRedis(), prefix })
    await events.waitUntilReady()
    worker = startCheckWorker(payload, { prefix, concurrency: 2 })
    setOnDemandTransport({ queue, events })
  })

  afterAll(async () => {
    setOnDemandTransport(undefined)
    await worker?.close()
    await events?.close()
    if (queue) {
      await queue.obliterate({ force: true })
      await queue.close()
    }
    await new Promise<void>((resolve) => server?.close(() => resolve()))
    const orgIds = [orgA?.id, orgB?.id].filter(Boolean)
    if (orgIds.length) {
      await payload.delete({ collection: 'heartbeats', where: { organization: { in: orgIds } } })
      await payload.delete({ collection: 'monitors', where: { organization: { in: orgIds } } })
      await payload.delete({ collection: 'proxies', where: { organization: { in: orgIds } } })
      await payload.delete({ collection: 'organizations', where: { id: { in: orgIds } } })
    }
    await payload.delete({
      collection: 'users',
      where: { email: { like: `+odc-${run}@marmot.test` } },
    })
  })

  describe('POST /api/orgs/:orgId/monitors/:id/check', () => {
    const path = (id: string | number) => `/api/orgs/${orgA.id}/monitors/${id}/check`

    it('runs the check on the worker and records a manual heartbeat', async () => {
      const monitor = await createMonitor({ name: 'check-now' })
      const res = await checkNow(request(path(monitor.id), undefined, member), {
        ...monitorParams(orgA.id, monitor.id),
      })
      expect(res.status).toBe(200)
      expect(res.headers.get('X-RateLimit-Limit')).toBe(String(env.ON_DEMAND_CHECKS_PER_MINUTE))
      const result = (await res.json()) as OnDemandCheckResult
      expect(result).toMatchObject({
        status: 'up',
        ok: true,
        msg: '200 - OK',
        statusCode: 200,
        recorded: true,
        blocked: false,
      })
      expect(result.ping).toEqual(expect.any(Number))
      expect(result.heartbeat?.status).toBe('up')

      const beats = await heartbeatsOf(monitor.id)
      expect(beats).toHaveLength(1)
      expect(beats[0]).toMatchObject({ status: 'up', trigger: 'manual' })
      expect(String(beats[0].id)).toBe(result.heartbeat?.id)

      // The beat fed the state machine: the monitor's status cache moved.
      const stored = await payload.findByID({ collection: 'monitors', id: monitor.id, depth: 0 })
      expect(stored.status?.lastStatus).toBe('up')
    })

    it('reports a failing check as DOWN with the status code', async () => {
      const monitor = await createMonitor({ name: 'check-now-down', url: `${baseUrl}/fail` })
      const res = await checkNow(request(path(monitor.id), undefined, member), {
        ...monitorParams(orgA.id, monitor.id),
      })
      const result = (await res.json()) as OnDemandCheckResult
      expect(result).toMatchObject({ status: 'down', ok: false, statusCode: 500, recorded: true })
    })

    it('does not store anything with record=false', async () => {
      const monitor = await createMonitor({ name: 'dry-run' })
      const res = await checkNow(request(`${path(monitor.id)}?record=false`, undefined, member), {
        ...monitorParams(orgA.id, monitor.id),
      })
      expect(res.status).toBe(200)
      const result = (await res.json()) as OnDemandCheckResult
      expect(result).toMatchObject({ status: 'up', recorded: false, heartbeat: null })
      expect(await heartbeatsOf(monitor.id)).toHaveLength(0)
      const stored = await payload.findByID({ collection: 'monitors', id: monitor.id, depth: 0 })
      expect(stored.status?.lastStatus ?? null).toBeNull()
    })

    it('answers 202 with wait=false and records the heartbeat in the background', async () => {
      const monitor = await createMonitor({ name: 'no-wait' })
      const res = await checkNow(request(`${path(monitor.id)}?wait=false`, undefined, member), {
        ...monitorParams(orgA.id, monitor.id),
      })
      expect(res.status).toBe(202)
      expect(await res.json()).toMatchObject({ status: 'queued', monitorId: String(monitor.id) })
      const deadline = Date.now() + 10_000
      while ((await heartbeatsOf(monitor.id)).length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      expect(await heartbeatsOf(monitor.id)).toHaveLength(1)
    })

    it('rejects anonymous users, viewers and other organizations', async () => {
      const monitor = await createMonitor({ name: 'guarded' })
      expect(
        (await checkNow(request(path(monitor.id)), monitorParams(orgA.id, monitor.id))).status,
      ).toBe(401)
      expect(
        (
          await checkNow(
            request(path(monitor.id), undefined, viewer),
            monitorParams(orgA.id, monitor.id),
          )
        ).status,
      ).toBe(403)
      expect(
        (
          await checkNow(
            request(path(monitor.id), undefined, outsider),
            monitorParams(orgA.id, monitor.id),
          )
        ).status,
      ).toBe(403)
      // A monitor of another organization reads as missing.
      const foreign = await createMonitor({ name: 'foreign' }, orgB)
      expect(
        (
          await checkNow(
            request(path(foreign.id), undefined, member),
            monitorParams(orgA.id, foreign.id),
          )
        ).status,
      ).toBe(404)
      expect(await heartbeatsOf(monitor.id)).toHaveLength(0)
    })

    it('refuses paused and push monitors with 409', async () => {
      const paused = await createMonitor({ name: 'paused', active: false })
      const pausedRes = await checkNow(request(path(paused.id), undefined, member), {
        ...monitorParams(orgA.id, paused.id),
      })
      expect(pausedRes.status).toBe(409)

      const push = await createMonitor({ name: 'push', type: 'push', url: null })
      const pushRes = await checkNow(request(path(push.id), undefined, member), {
        ...monitorParams(orgA.id, push.id),
      })
      expect(pushRes.status).toBe(409)
      expect(await heartbeatsOf(push.id)).toHaveLength(0)
    })

    it('drops a job nobody waits for any more', async () => {
      const monitor = await createMonitor({ name: 'expired' })
      await expect(
        processManualCheckJob(payload, {
          monitorId: String(monitor.id),
          record: true,
          deadline: Date.now() - 1,
        }),
      ).rejects.toBeInstanceOf(OnDemandSkipError)
      expect(await heartbeatsOf(monitor.id)).toHaveLength(0)
    })
  })

  describe('POST /api/orgs/:orgId/checks', () => {
    const path = () => `/api/orgs/${orgA.id}/checks`

    it('tests an unsaved configuration without storing a heartbeat', async () => {
      const before = await payload.count({
        collection: 'heartbeats',
        where: { organization: { equals: orgA.id } },
      })
      const res = await adhocCheck(request(path(), httpConfig('/fail'), member), orgParams(orgA.id))
      expect(res.status).toBe(200)
      const result = (await res.json()) as OnDemandCheckResult
      expect(result).toMatchObject({
        status: 'down',
        ok: false,
        statusCode: 500,
        msg: '500 - Internal Server Error',
        recorded: false,
        heartbeat: null,
      })

      const ok = (await (
        await adhocCheck(request(path(), httpConfig('/ok'), member), orgParams(orgA.id))
      ).json()) as OnDemandCheckResult
      expect(ok).toMatchObject({ status: 'up', statusCode: 200 })

      const after = await payload.count({
        collection: 'heartbeats',
        where: { organization: { equals: orgA.id } },
      })
      expect(after.totalDocs).toBe(before.totalDocs)
    })

    it('returns per-assertion results', async () => {
      const res = await adhocCheck(
        request(
          path(),
          {
            ...httpConfig('/ok'),
            assertions: [
              { kind: 'status', comparator: 'eq', value: '200' },
              { kind: 'textBody', comparator: 'contains', value: 'missing' },
            ],
          },
          member,
        ),
        orgParams(orgA.id),
      )
      expect(res.status).toBe(200)
      const result = (await res.json()) as OnDemandCheckResult
      expect(result.status).toBe('down')
      expect(result.assertions).toEqual([
        expect.objectContaining({ kind: 'status', passed: true, actual: '200' }),
        expect.objectContaining({ kind: 'textBody', passed: false }),
      ])
    })

    it('applies upside-down mode', async () => {
      const res = await adhocCheck(
        request(path(), { ...httpConfig('/fail'), upsideDown: true }, member),
        orgParams(orgA.id),
      )
      expect(((await res.json()) as OnDemandCheckResult).status).toBe('up')
    })

    it('validates the body and refuses types that cannot be tested', async () => {
      const invalid = await adhocCheck(
        request(path(), { ...httpConfig('/ok'), url: 'ftp://x' }, member),
        orgParams(orgA.id),
      )
      expect(invalid.status).toBe(400)

      const push = await adhocCheck(
        request(path(), { ...defaultMonitorValues('push'), name: 'p' }, member),
        orgParams(orgA.id),
      )
      expect(push.status).toBe(400)
    })

    it('rejects viewers and anonymous users', async () => {
      expect(
        (await adhocCheck(request(path(), httpConfig('/ok')), orgParams(orgA.id))).status,
      ).toBe(401)
      expect(
        (await adhocCheck(request(path(), httpConfig('/ok'), viewer), orgParams(orgA.id))).status,
      ).toBe(403)
    })

    it("refuses another organization's proxy", async () => {
      const proxy = await payload.create({
        collection: 'proxies',
        overrideAccess: true,
        data: {
          organization: orgB.id,
          protocol: 'http',
          host: 'proxy.example.com',
          port: 3128,
        } as never,
      })
      const res = await adhocCheck(
        request(path(), { ...httpConfig('/ok'), proxy: proxy.id }, member),
        orgParams(orgA.id),
      )
      expect(res.status).toBe(400)
      const body = (await res.json()) as { errors: { data: { issues: { path: string }[] } }[] }
      expect(body.errors[0].data.issues[0].path).toBe('proxy')
    })

    it('refuses private targets while the outbound guard is on', async () => {
      const saved = process.env.MONITOR_DENY_PRIVATE_ADDRESSES
      process.env.MONITOR_DENY_PRIVATE_ADDRESSES = 'true'
      resetEnvCache()
      try {
        const res = await adhocCheck(request(path(), httpConfig('/ok'), member), orgParams(orgA.id))
        expect(res.status).toBe(400)
        const body = (await res.json()) as {
          errors: { data: { issues: { path: string; message: string }[] } }[]
        }
        expect(body.errors[0].data.issues[0]).toMatchObject({ path: 'url' })
        expect(body.errors[0].data.issues[0].message).toMatch(/^Blocked/)
      } finally {
        if (saved === undefined) delete process.env.MONITOR_DENY_PRIVATE_ADDRESSES
        else process.env.MONITOR_DENY_PRIVATE_ADDRESSES = saved
        resetEnvCache()
      }
    })

    it('is rate-limited per organization', async () => {
      // Use up orgB's budget; orgA keeps its own.
      for (let i = 0; i < onDemandCheckLimiter.points; i++) {
        await onDemandCheckLimiter.consume(String(orgB.id))
      }
      const res = await adhocCheck(
        request(`/api/orgs/${orgB.id}/checks`, httpConfig('/ok'), outsider),
        orgParams(orgB.id),
      )
      expect(res.status).toBe(429)
      expect(res.headers.get('Retry-After')).toBeTruthy()

      const other = await adhocCheck(request(path(), httpConfig('/ok'), member), orgParams(orgA.id))
      expect(other.status).toBe(200)
    })
  })
})
