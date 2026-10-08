import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { getPayload, type Payload, type RequiredDataFromCollectionSlug } from 'payload'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import config from '@payload-config'
import { addOrgMembership } from '@/access/memberships'
import type { Role } from '@/access/permissions'
import { GET as listLogs } from '@/app/api/orgs/[orgId]/monitors/[id]/logs/route'
import { GET as getLog } from '@/app/api/orgs/[orgId]/monitors/[id]/logs/[heartbeatId]/route'
import { GET as listHeartbeats } from '@/app/api/orgs/[orgId]/monitors/[id]/heartbeats/route'
import { env } from '@/env'
import {
  REDACTED,
  RESPONSE_BODY_LIMIT_BYTES,
  type ResponseLogDetail,
  type ResponseLogPage,
} from '@/lib/response-log'
import type { Heartbeat, Monitor, Organization, User } from '@/payload-types'
import { processCheckJob, type ChecksQueue } from '@/server/engine'
import { processManualCheckJob } from '@/server/engine/on-demand-jobs'

/**
 * Per-check response log (#97): what HTTP checks store (status code, capped headers, the body of
 * failed and degraded checks only, never request secrets) and the org-scoped log API with filters
 * and cursor paging.
 */

let payload: Payload
let server: http.Server
let port: number
let orgA: Organization
let orgB: Organization
let viewer: Session
let outsider: Session

const run = Date.now().toString(36)
const email = (name: string) => `${name}+rlog-${run}@marmot.test`
const PASSWORD = 'password-123'
const TOKEN = `tok-${run}-secret`
const API_KEY = `key-${run}-secret`

type Session = { user: User; cookie: string }

const queue = {
  upsertJobScheduler: vi.fn(async () => undefined),
  removeJobScheduler: vi.fn(async () => true),
} as unknown as ChecksQueue

/** Echoes the request headers in its body, so a leak of the credentials would show. */
const handler: http.RequestListener = (req, res) => {
  const echo = JSON.stringify({ headers: req.headers })
  if (req.url === '/ok') {
    res.writeHead(200, {
      'content-type': 'application/json',
      'set-cookie': 'session=very-secret-cookie; HttpOnly',
      'x-echo-auth': String(req.headers.authorization ?? ''),
    })
    res.end(echo)
    return
  }
  if (req.url === '/fail') {
    res.writeHead(503, { 'content-type': 'application/json' })
    res.end(echo + ' '.repeat(RESPONSE_BODY_LIMIT_BYTES))
    return
  }
  if (req.url === '/slow') {
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('slow but fine')
    }, 50)
    return
  }
  res.writeHead(404)
  res.end('nope')
}

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

/** The user with its memberships, as a request would carry it. */
async function fresh(session: Session) {
  const user = await payload.findByID({ collection: 'users', id: session.user.id, depth: 0 })
  return { ...user, collection: 'users' as const }
}

async function createMonitor(
  org: Organization,
  data: Partial<Monitor> & { name: string; type: Monitor['type'] },
) {
  return (await payload.create({
    collection: 'monitors',
    overrideAccess: true,
    depth: 0,
    data: {
      organization: org.id,
      interval: 60,
      retryInterval: 20,
      maxRetries: 0,
      resendInterval: 0,
      timeout: 10,
      ...data,
    } as RequiredDataFromCollectionSlug<'monitors'>,
  })) as Monitor
}

async function check(monitor: Monitor): Promise<Heartbeat> {
  const result = await processCheckJob(
    payload,
    { data: { monitorId: String(monitor.id) } },
    { queue },
  )
  expect(result.outcome).toBe('processed')
  return payload.findByID({
    collection: 'heartbeats',
    id: (result.heartbeat as Heartbeat).id,
    depth: 0,
    overrideAccess: true,
  })
}

const authedMonitor = (name: string, path: string) =>
  createMonitor(orgA, {
    name,
    type: 'http',
    url: `http://127.0.0.1:${port}${path}`,
    authMethod: 'bearer',
    bearerToken: TOKEN,
    headers: JSON.stringify({ 'X-Api-Key': API_KEY }),
  })

function get(url: string, session?: Session): Request {
  return new Request(`http://localhost${url}`, {
    headers: { Origin: env.NEXT_PUBLIC_SERVER_URL, ...(session ? { cookie: session.cookie } : {}) },
  })
}

async function logs(
  monitor: Monitor,
  query: Record<string, string> = {},
  session: Session = viewer,
  org: Organization = orgA,
) {
  const qs = new URLSearchParams(query).toString()
  const res = await listLogs(
    get(`/api/orgs/${org.id}/monitors/${monitor.id}/logs?${qs}`, session),
    {
      params: Promise.resolve({ orgId: String(org.id), id: String(monitor.id) }),
    },
  )
  return { status: res.status, body: (await res.json()) as ResponseLogPage }
}

async function detail(monitor: Monitor, heartbeatId: string | number, session: Session = viewer) {
  const res = await getLog(
    get(`/api/orgs/${orgA.id}/monitors/${monitor.id}/logs/${heartbeatId}`, session),
    {
      params: Promise.resolve({
        orgId: String(orgA.id),
        id: String(monitor.id),
        heartbeatId: String(heartbeatId),
      }),
    },
  )
  return { status: res.status, body: (await res.json()) as ResponseLogDetail }
}

beforeAll(async () => {
  payload = await getPayload({ config })
  orgA = await payload.create({
    collection: 'organizations',
    data: { name: 'Log A', slug: `rlog-a-${run}` },
  })
  orgB = await payload.create({
    collection: 'organizations',
    data: { name: 'Log B', slug: `rlog-b-${run}` },
  })
  viewer = await createMember('viewer', orgA, 'viewer')
  outsider = await createMember('outsider', orgB, 'owner')
  server = http.createServer(handler)
  port = await new Promise<number>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)),
  )
})

afterAll(async () => {
  server?.closeAllConnections()
  await new Promise((resolve) => server?.close(resolve))
  const orgIds = [orgA?.id, orgB?.id].filter(Boolean)
  for (const collection of ['stat-minutely', 'stat-hourly', 'stat-daily', 'heartbeats'] as const) {
    await payload.delete({
      collection,
      where: { organization: { in: orgIds } },
      overrideAccess: true,
    })
  }
  await payload.delete({ collection: 'monitors', where: { organization: { in: orgIds } } })
  await payload.delete({ collection: 'organizations', where: { id: { in: orgIds } } })
  await payload.delete({
    collection: 'users',
    where: { email: { like: `+rlog-${run}@marmot.test` } },
  })
})

describe('response capture on heartbeats', () => {
  it('stores the status code and headers of a successful check, but not its body', async () => {
    const monitor = await authedMonitor('ok', '/ok')
    const beat = await check(monitor)
    expect(beat.status).toBe('up')
    expect(beat.statusCode).toBe(200)
    const headers = beat.response?.headers as Record<string, string>
    expect(headers['content-type']).toBe('application/json')
    expect(headers['set-cookie']).toBe(REDACTED)
    // The target echoed our Authorization header back: scrubbed.
    expect(headers['x-echo-auth']).toBe(REDACTED)
    expect(beat.response?.body ?? null).toBeNull()
    const stored = JSON.stringify(beat)
    expect(stored).not.toContain(TOKEN)
    expect(stored).not.toContain('very-secret-cookie')
  })

  it('stores the first 16 KB of the body of a failed check, with request secrets scrubbed', async () => {
    const monitor = await authedMonitor('fail', '/fail')
    const beat = await check(monitor)
    expect(beat.status).toBe('down')
    expect(beat.statusCode).toBe(503)
    const body = beat.response?.body as string
    expect(body).toContain('"x-api-key"')
    expect(body).toContain(REDACTED)
    expect(new TextEncoder().encode(body).length).toBeLessThanOrEqual(RESPONSE_BODY_LIMIT_BYTES)
    expect(beat.response?.bodyTruncated).toBe(true)
    const stored = JSON.stringify(beat)
    expect(stored).not.toContain(TOKEN)
    expect(stored).not.toContain(API_KEY)
    // The status assertion result is the one stored by #218; the log reuses it.
    expect(Array.isArray(beat.assertions)).toBe(true)
  })

  it('stores the body of a degraded check', async () => {
    const monitor = await createMonitor(orgA, {
      name: 'slow',
      type: 'http',
      url: `http://127.0.0.1:${port}/slow`,
      degradedAfter: 1,
    })
    const beat = await check(monitor)
    expect(beat.status).toBe('degraded')
    expect(beat.response?.body).toBe('slow but fine')
  })

  it('marks manual checks', async () => {
    const monitor = await authedMonitor('manual', '/ok')
    const result = await processManualCheckJob(
      payload,
      { monitorId: String(monitor.id), record: true, deadline: Date.now() + 60_000 },
      { queue },
    )
    expect(result.recorded).toBe(true)
    const { body } = await logs(monitor, { trigger: 'manual' })
    expect(body.docs).toHaveLength(1)
    expect(body.docs[0]).toMatchObject({ trigger: 'manual', statusCode: 200, status: 'up' })
  })
})

describe('log API', () => {
  let monitor: Monitor
  let other: Monitor
  const ids: Record<string, string | number> = {}
  const now = Date.now()
  const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString()

  beforeAll(async () => {
    monitor = await createMonitor(orgA, { name: 'api', type: 'http', url: 'http://127.0.0.1/' })
    other = await createMonitor(orgA, { name: 'other', type: 'http', url: 'http://127.0.0.1/' })
    const rows: [string, Partial<Heartbeat>][] = [
      ['up', { status: 'up', statusCode: 200, time: at(1) }],
      ['down503', { status: 'down', statusCode: 503, time: at(2), important: true }],
      ['down404', { status: 'down', statusCode: 404, time: at(3) }],
      ['manual500', { status: 'down', statusCode: 500, time: at(4), trigger: 'manual' }],
      // Two beats at the same instant: the cursor must neither skip nor repeat one.
      ['tieA', { status: 'pending', statusCode: 502, time: at(5) }],
      ['tieB', { status: 'pending', statusCode: 502, time: at(5) }],
      ['old', { status: 'down', statusCode: 500, time: at(60 * 24 * 8), important: true }],
    ]
    for (const [name, data] of rows) {
      const doc = await payload.create({
        collection: 'heartbeats',
        overrideAccess: true,
        data: {
          monitor: monitor.id,
          organization: orgA.id,
          msg: name,
          ping: 12,
          ...data,
          ...(name === 'down503'
            ? {
                response: {
                  headers: { 'content-type': 'text/html' },
                  body: '<h1>Service Unavailable</h1>',
                },
                timing: { dns: 1, connect: 2, tls: null, ttfb: 30, transfer: 1 },
                probes: [{ location: 'Frankfurt, DE', ok: false, latency: 31, msg: '503' }],
              }
            : {}),
        } as RequiredDataFromCollectionSlug<'heartbeats'>,
      })
      ids[name] = doc.id
    }
    const foreign = await payload.create({
      collection: 'heartbeats',
      overrideAccess: true,
      data: { monitor: other.id, organization: orgA.id, status: 'down', time: at(1) },
    })
    ids.foreign = foreign.id
  })

  const names = (page: ResponseLogPage) => page.docs.map((row) => row.msg)

  it('lists checks newest first for a viewer', async () => {
    const { status, body } = await logs(monitor)
    expect(status).toBe(200)
    expect(names(body).slice(0, 4)).toEqual(['up', 'down503', 'down404', 'manual500'])
    expect(body.docs).toHaveLength(7)
    expect(body.nextCursor).toBeNull()
    expect(body.docs[0]).toMatchObject({ trigger: 'schedule', statusCode: 200 })
    expect(body.docs[0]).not.toHaveProperty('response')
  })

  it('filters "failed in the last 7 days, status 5xx"', async () => {
    const { body } = await logs(monitor, {
      status: 'down',
      statusCode: '5xx',
      from: new Date(now - 7 * 86_400_000).toISOString(),
    })
    expect(names(body)).toEqual(['down503', 'manual500'])
  })

  it('filters by exact code, status list, trigger and time window', async () => {
    expect(names((await logs(monitor, { statusCode: '404' })).body)).toEqual(['down404'])
    expect(names((await logs(monitor, { status: 'up,pending' })).body).sort()).toEqual([
      'tieA',
      'tieB',
      'up',
    ])
    expect(names((await logs(monitor, { trigger: 'manual' })).body)).toEqual(['manual500'])
    expect(names((await logs(monitor, { trigger: 'schedule' })).body)).not.toContain('manual500')
    expect((await logs(monitor, { trigger: 'schedule' })).body.docs).toHaveLength(6)
    expect(names((await logs(monitor, { from: at(3.5), to: at(1.5) })).body)).toEqual([
      'down503',
      'down404',
    ])
  })

  it('pages with a cursor without skipping or repeating rows at the same instant', async () => {
    const seen: string[] = []
    let cursor: string | null = null
    for (let i = 0; i < 10; i += 1) {
      const { status, body } = await logs(monitor, {
        limit: '2',
        ...(cursor ? { cursor } : {}),
      })
      expect(status).toBe(200)
      seen.push(...body.docs.map((row) => row.id))
      cursor = body.nextCursor
      if (!cursor) break
    }
    expect(seen).toHaveLength(7)
    expect(new Set(seen).size).toBe(7)
    expect(seen.map(String).sort()).toEqual(
      ['up', 'down503', 'down404', 'manual500', 'tieA', 'tieB', 'old']
        .map((n) => String(ids[n]))
        .sort(),
    )
  })

  it('rejects invalid filters and cursors', async () => {
    expect((await logs(monitor, { status: 'broken' })).status).toBe(400)
    expect((await logs(monitor, { statusCode: '5x' })).status).toBe(400)
    expect((await logs(monitor, { cursor: 'not-a-cursor' })).status).toBe(400)
  })

  it('returns one check in full', async () => {
    const { status, body } = await detail(monitor, ids.down503!)
    expect(status).toBe(200)
    expect(body).toMatchObject({
      status: 'down',
      statusCode: 503,
      important: true,
      response: {
        headers: { 'content-type': 'text/html' },
        body: '<h1>Service Unavailable</h1>',
        bodyTruncated: false,
      },
      timing: { dns: 1, connect: 2, tls: null, ttfb: 30, transfer: 1 },
      probes: [{ location: 'Frankfurt, DE', ok: false, latency: 31, msg: '503' }],
    })
  })

  it('keeps logs org-scoped', async () => {
    // A heartbeat of another monitor is not reachable through this monitor.
    expect((await detail(monitor, ids.foreign!)).status).toBe(404)
    // Members of another organization get nothing.
    expect((await logs(monitor, {}, outsider)).status).toBe(403)
    expect((await detail(monitor, ids.down503!, outsider)).status).toBe(403)
    // Nor through their own organization's path.
    expect((await logs(monitor, {}, outsider, orgB)).status).toBe(404)
    // Nor through Payload's REST/Local API with their access.
    const { docs } = await payload.find({
      collection: 'heartbeats',
      where: { monitor: { equals: monitor.id } },
      user: await fresh(outsider),
      overrideAccess: false,
    })
    expect(docs).toHaveLength(0)
    const own = await payload.find({
      collection: 'heartbeats',
      where: { monitor: { equals: monitor.id } },
      user: await fresh(viewer),
      overrideAccess: false,
    })
    expect(own.docs.length).toBeGreaterThan(0)
  })

  it('keeps the heartbeats route as it was', async () => {
    const res = await listHeartbeats(
      get(`/api/orgs/${orgA.id}/monitors/${monitor.id}/heartbeats?limit=2`, viewer),
      { params: Promise.resolve({ orgId: String(orgA.id), id: String(monitor.id) }) },
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { docs: Record<string, unknown>[] }
    expect(body.docs).toHaveLength(2)
    expect(Object.keys(body.docs[0]!).sort()).toEqual(
      ['id', 'important', 'msg', 'ping', 'status', 'time'].sort(),
    )
  })
})
