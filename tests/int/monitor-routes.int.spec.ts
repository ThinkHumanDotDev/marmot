import { getPayload, type Payload } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import config from '@payload-config'
import { addOrgMembership } from '@/access/memberships'
import type { Role } from '@/access/permissions'
import { POST as createMonitor } from '@/app/api/orgs/[orgId]/monitors/route'
import {
  DELETE as deleteMonitor,
  PATCH as updateMonitor,
} from '@/app/api/orgs/[orgId]/monitors/[id]/route'
import { POST as cloneMonitor } from '@/app/api/orgs/[orgId]/monitors/[id]/clone/route'
import { POST as pauseMonitor } from '@/app/api/orgs/[orgId]/monitors/[id]/pause/route'
import { POST as resumeMonitor } from '@/app/api/orgs/[orgId]/monitors/[id]/resume/route'
import { env } from '@/env'
import { defaultMonitorValues } from '@/lib/validation/monitor'
import { monitorFormSchema } from '@/lib/validation/monitor-schema'
import type { Monitor, Organization, User } from '@/payload-types'

let payload: Payload

const run = Date.now().toString(36)
const email = (name: string) => `${name}+mon-${run}@marmot.test`
const PASSWORD = 'password-123'

type Session = { user: User; cookie: string }

async function createMember(name: string, org: Organization | null, role: Role): Promise<Session> {
  const user = await payload.create({
    collection: 'users',
    data: { email: email(name), password: PASSWORD, name },
  })
  if (org) await addOrgMembership({ payload, userId: user.id, orgId: org.id, role })
  const { token } = await payload.login({
    collection: 'users',
    data: { email: email(name), password: PASSWORD },
  })
  return { user, cookie: `payload-token=${token}` }
}

const params = (orgId: string | number, id?: string | number) =>
  Promise.resolve({ orgId: String(orgId), id: String(id ?? '') })

/** Browser-like request: Payload only honours the cookie when `Origin` passes its CSRF allowlist. */
function request(method: string, body?: unknown, session?: Session): Request {
  return new Request('http://localhost/api/orgs/x/monitors', {
    method,
    headers: {
      Origin: env.NEXT_PUBLIC_SERVER_URL,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(session ? { cookie: session.cookie } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
}

const httpMonitor = (name: string) => ({
  ...defaultMonitorValues('http'),
  name,
  url: 'http://localhost:3000/api/health',
})

let orgA: Organization
let orgB: Organization
let member: Session
let viewer: Session
let outsider: Session
let noOrg: Session

describe('monitor route handlers', () => {
  beforeAll(async () => {
    payload = await getPayload({ config })
    orgA = await payload.create({
      collection: 'organizations',
      data: { name: 'Mon A', slug: `mon-a-${run}` },
    })
    orgB = await payload.create({
      collection: 'organizations',
      data: { name: 'Mon B', slug: `mon-b-${run}` },
    })
    member = await createMember('member', orgA, 'member')
    viewer = await createMember('viewer', orgA, 'viewer')
    outsider = await createMember('outsider', orgB, 'owner')
    noOrg = await createMember('noorg', null, 'member')
  })

  afterAll(async () => {
    const orgIds = [orgA?.id, orgB?.id].filter(Boolean)
    if (orgIds.length) {
      await payload.delete({ collection: 'monitors', where: { organization: { in: orgIds } } })
      await payload.delete({ collection: 'organizations', where: { id: { in: orgIds } } })
    }
    await payload.delete({
      collection: 'users',
      where: { email: { like: `+mon-${run}@marmot.test` } },
    })
  })

  describe('schema', () => {
    it('enforces per-type requirements', () => {
      expect(monitorFormSchema.safeParse(httpMonitor('ok')).success).toBe(true)
      const noUrl = monitorFormSchema.safeParse({
        ...defaultMonitorValues('http'),
        name: 'x',
        url: '',
      })
      expect(noUrl.success).toBe(false)
      expect(noUrl.error?.issues.map((i) => i.path.join('.'))).toContain('url')

      const port = monitorFormSchema.safeParse({ ...defaultMonitorValues('port'), name: 'p' })
      expect(port.error?.issues.map((i) => i.path.join('.'))).toEqual(
        expect.arrayContaining(['hostname', 'port']),
      )
      expect(
        monitorFormSchema.safeParse({
          ...defaultMonitorValues('port'),
          name: 'p',
          hostname: 'localhost',
          port: 22,
        }).success,
      ).toBe(true)

      const badHeaders = monitorFormSchema.safeParse({
        ...httpMonitor('h'),
        headers: 'not json',
        acceptedStatusCodes: ['2xx'],
        interval: 5,
      })
      expect(badHeaders.error?.issues.map((i) => i.path.join('.'))).toEqual(
        expect.arrayContaining(['headers', 'acceptedStatusCodes', 'interval']),
      )

      expect(
        monitorFormSchema.safeParse({ ...defaultMonitorValues('group'), name: 'g' }).success,
      ).toBe(true)
      expect(
        monitorFormSchema.safeParse({
          ...defaultMonitorValues('manual'),
          name: 'm',
          manualStatus: null,
        }).success,
      ).toBe(false)
    })
  })

  describe('POST /api/orgs/:orgId/monitors', () => {
    it('rejects anonymous requests with 401', async () => {
      const res = await createMonitor(request('POST', httpMonitor('anon')), {
        params: params(orgA.id),
      })
      expect(res.status).toBe(401)
    })

    it('rejects viewers and non-members with 403', async () => {
      expect(
        (
          await createMonitor(request('POST', httpMonitor('v'), viewer), {
            params: params(orgA.id),
          })
        ).status,
      ).toBe(403)
      expect(
        (
          await createMonitor(request('POST', httpMonitor('o'), outsider), {
            params: params(orgA.id),
          })
        ).status,
      ).toBe(403)
      expect(
        (await createMonitor(request('POST', httpMonitor('n'), noOrg), { params: params(orgA.id) }))
          .status,
      ).toBe(403)
    })

    it('returns 400 with field issues for an invalid body', async () => {
      const res = await createMonitor(
        request('POST', { ...defaultMonitorValues('http'), name: 'bad', url: 'ftp://x' }, member),
        { params: params(orgA.id) },
      )
      expect(res.status).toBe(400)
      const body = (await res.json()) as { errors: { data: { issues: { path: string }[] } }[] }
      expect(body.errors[0].data.issues.map((i) => i.path)).toContain('url')
    })

    it('creates the monitor in the organization for a member', async () => {
      const res = await createMonitor(request('POST', httpMonitor('created'), member), {
        params: params(orgA.id),
      })
      expect(res.status).toBe(201)
      const doc = (await res.json()) as Monitor
      expect(doc.name).toBe('created')
      expect(String(doc.organization)).toBe(String(orgA.id))
      expect(doc.acceptedStatusCodes).toEqual(['200-299'])
    })

    it('ignores an organization in the body', async () => {
      const res = await createMonitor(
        request('POST', { ...httpMonitor('spoof'), organization: orgB.id }, member),
        { params: params(orgA.id) },
      )
      expect(res.status).toBe(201)
      expect(String(((await res.json()) as Monitor).organization)).toBe(String(orgA.id))
    })
  })

  describe('PATCH / pause / resume / clone / DELETE', () => {
    let monitor: Monitor

    beforeAll(async () => {
      const res = await createMonitor(request('POST', httpMonitor('lifecycle'), member), {
        params: params(orgA.id),
      })
      monitor = (await res.json()) as Monitor
    })

    it('updates with a partial body and re-validates the whole document', async () => {
      const ok = await updateMonitor(request('PATCH', { interval: 120, name: 'renamed' }, member), {
        params: params(orgA.id, monitor.id),
      })
      expect(ok.status).toBe(200)
      const doc = (await ok.json()) as Monitor
      expect(doc.name).toBe('renamed')
      expect(doc.interval).toBe(120)
      expect(doc.url).toBe('http://localhost:3000/api/health')

      const bad = await updateMonitor(request('PATCH', { url: '' }, member), {
        params: params(orgA.id, monitor.id),
      })
      expect(bad.status).toBe(400)

      const viewerRes = await updateMonitor(request('PATCH', { name: 'nope' }, viewer), {
        params: params(orgA.id, monitor.id),
      })
      expect(viewerRes.status).toBe(403)
    })

    it('pauses and resumes', async () => {
      const paused = await pauseMonitor(request('POST', undefined, member), {
        params: params(orgA.id, monitor.id),
      })
      expect(paused.status).toBe(200)
      expect(((await paused.json()) as Monitor).active).toBe(false)

      const resumed = await resumeMonitor(request('POST', undefined, member), {
        params: params(orgA.id, monitor.id),
      })
      expect(resumed.status).toBe(200)
      expect(((await resumed.json()) as Monitor).active).toBe(true)
    })

    it('clones as a paused copy without the status cache', async () => {
      await payload.update({
        collection: 'monitors',
        id: monitor.id,
        data: { status: { lastStatus: 'up', lastPing: 12 } },
        context: { skipEngineSync: true },
      })
      const res = await cloneMonitor(request('POST', undefined, member), {
        params: params(orgA.id, monitor.id),
      })
      expect(res.status).toBe(201)
      const copy = (await res.json()) as Monitor
      expect(copy.id).not.toBe(monitor.id)
      expect(copy.name).toBe('renamed (copy)')
      expect(copy.active).toBe(false)
      expect(copy.url).toBe(monitor.url)
      expect(copy.status?.lastStatus ?? null).toBeNull()
      expect(String(copy.organization)).toBe(String(orgA.id))
    })

    it('answers 404 for monitors of another organization', async () => {
      // orgB's owner cannot see orgA's monitor through the orgB route…
      const viaOwnOrg = await updateMonitor(request('PATCH', { name: 'x' }, outsider), {
        params: params(orgB.id, monitor.id),
      })
      expect(viaOwnOrg.status).toBe(404)
      // …and is forbidden on orgA's route.
      const viaForeignOrg = await updateMonitor(request('PATCH', { name: 'x' }, outsider), {
        params: params(orgA.id, monitor.id),
      })
      expect(viaForeignOrg.status).toBe(403)
      // The Local API with the user's access hides it as well (re-read so memberships are current).
      const fresh = await payload.findByID({ collection: 'users', id: outsider.user.id, depth: 0 })
      const asOutsider = { ...fresh, collection: 'users' as const }
      await expect(
        payload.findByID({
          collection: 'monitors',
          id: monitor.id,
          user: asOutsider,
          overrideAccess: false,
        }),
      ).rejects.toThrow()
      const list = await payload.find({
        collection: 'monitors',
        user: asOutsider,
        overrideAccess: false,
        depth: 0,
      })
      expect(list.docs.map((d) => String(d.id))).not.toContain(String(monitor.id))
    })

    it('deletes the monitor with its heartbeats and stats', async () => {
      await payload.create({
        collection: 'heartbeats',
        data: {
          monitor: monitor.id,
          organization: orgA.id,
          status: 'up',
          time: new Date().toISOString(),
          important: true,
        },
      })
      const forbidden = await deleteMonitor(request('DELETE', undefined, viewer), {
        params: params(orgA.id, monitor.id),
      })
      expect(forbidden.status).toBe(403)

      const res = await deleteMonitor(request('DELETE', undefined, member), {
        params: params(orgA.id, monitor.id),
      })
      expect(res.status).toBe(200)
      await expect(
        payload.findByID({ collection: 'monitors', id: monitor.id, depth: 0 }),
      ).rejects.toThrow()
      const beats = await payload.count({
        collection: 'heartbeats',
        where: { monitor: { equals: monitor.id } },
      })
      expect(beats.totalDocs).toBe(0)

      const again = await deleteMonitor(request('DELETE', undefined, member), {
        params: params(orgA.id, monitor.id),
      })
      expect(again.status).toBe(404)
    })
  })
})
