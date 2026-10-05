import {
  getPayload,
  type Payload,
  type RequiredDataFromCollectionSlug,
  type Where,
} from 'payload'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import config from '@payload-config'
import { addOrgMembership } from '@/access/memberships'
import type { Role } from '@/access/permissions'
import { GET as listMaintenance, POST as createMaintenance } from '@/app/api/orgs/[orgId]/maintenance/route'
import {
  DELETE as deleteMaintenance,
  GET as readMaintenance,
  PATCH as updateMaintenance,
} from '@/app/api/orgs/[orgId]/maintenance/[id]/route'
import { POST as pauseMaintenance } from '@/app/api/orgs/[orgId]/maintenance/[id]/pause/route'
import { POST as resumeMaintenance } from '@/app/api/orgs/[orgId]/maintenance/[id]/resume/route'
import { env } from '@/env'
import {
  defaultMaintenanceValues,
  maintenanceFormSchema,
  type MaintenanceFormValues,
} from '@/lib/validation/maintenance'
import type { Maintenance, Monitor, Organization, StatusPage, User } from '@/payload-types'
import {
  clearHeartbeatListeners,
  processCheckJob,
  setMaintenanceResolver,
  type ChecksQueue,
} from '@/server/engine'
import {
  createMaintenanceResolver,
  getActiveMaintenanceForStatusPage,
  isMonitorUnderMaintenance,
  refreshMaintenanceStatuses,
  resetOrganizationTimezoneCache,
  type MaintenanceSummary,
} from '@/server/maintenance'

let payload: Payload

const run = Date.now().toString(36)
const email = (name: string) => `${name}+mnt-${run}@marmot.test`
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
  return new Request('http://localhost/api/orgs/x/maintenance', {
    method,
    headers: {
      Origin: env.NEXT_PUBLIC_SERVER_URL,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(session ? { cookie: session.cookie } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
}

/** Queue stub: no DB test touches Redis. */
const fakeQueue = {
  upsertJobScheduler: vi.fn(async () => undefined),
  removeJobScheduler: vi.fn(async () => true),
} as unknown as ChecksQueue

const check = (monitorId: string | number) =>
  processCheckJob(payload, { data: { monitorId: String(monitorId) } }, { queue: fakeQueue })

type MonitorInput = RequiredDataFromCollectionSlug<'monitors'>
type MaintenanceInput = RequiredDataFromCollectionSlug<'maintenance'>

async function createMonitor(
  org: Organization,
  data: Partial<Monitor> & { name: string },
): Promise<Monitor> {
  return (await payload.create({
    collection: 'monitors',
    overrideAccess: true,
    depth: 0,
    data: {
      organization: org.id,
      type: 'manual',
      manualStatus: 'up',
      interval: 60,
      retryInterval: 20,
      maxRetries: 0,
      resendInterval: 0,
      timeout: 5,
      ...data,
    } as MonitorInput,
  })) as Monitor
}

async function createDoc(
  org: Organization,
  data: Partial<Maintenance> & { title: string },
): Promise<Maintenance> {
  return (await payload.create({
    collection: 'maintenance',
    overrideAccess: true,
    depth: 0,
    data: { organization: org.id, strategy: 'manual', active: true, ...data } as MaintenanceInput,
  })) as Maintenance
}

const iso = (minutesFromNow: number) =>
  new Date(Date.now() + minutesFromNow * 60_000).toISOString()

let orgA: Organization
let orgB: Organization
let member: Session
let viewer: Session
let outsider: Session

describe('maintenance windows', () => {
  beforeAll(async () => {
    payload = await getPayload({ config })
    orgA = await payload.create({
      collection: 'organizations',
      data: { name: 'Mnt A', slug: `mnt-a-${run}`, settings: { timezone: 'Asia/Tokyo' } },
    })
    orgB = await payload.create({
      collection: 'organizations',
      data: { name: 'Mnt B', slug: `mnt-b-${run}` },
    })
    member = await createMember('member', orgA, 'member')
    viewer = await createMember('viewer', orgA, 'viewer')
    outsider = await createMember('outsider', orgB, 'owner')
  })

  afterAll(async () => {
    setMaintenanceResolver(null)
    const orgIds = [orgA?.id, orgB?.id].filter(Boolean)
    if (orgIds.length) {
      // `delete({ where })` reports per-document failures instead of throwing; surface them.
      const wipe = async (
        collection: 'maintenance' | 'status-pages' | 'monitors',
        extra: Where = {},
      ) => {
        const where: Where = { and: [{ organization: { in: orgIds } }, extra] }
        const result = await payload.delete({ collection, where, depth: 0 })
        if (result.errors.length) {
          throw new Error(`${collection} cleanup: ${JSON.stringify(result.errors)}`)
        }
      }
      await wipe('maintenance')
      await wipe('status-pages')
      // Group children first: deleting a group and its child in one batch leaves the child behind.
      await wipe('monitors', { parent: { exists: true } })
      await wipe('monitors')
      await payload.delete({ collection: 'organizations', where: { id: { in: orgIds } } })
    }
    await payload.delete({
      collection: 'users',
      where: { email: { like: `+mnt-${run}@marmot.test` } },
    })
  })

  afterEach(() => {
    clearHeartbeatListeners()
    setMaintenanceResolver(null)
    resetOrganizationTimezoneCache()
  })

  describe('collection', () => {
    it('persists the computed status on save', async () => {
      const manual = await createDoc(orgA, { title: 'manual' })
      expect(manual.status).toBe('under-maintenance')

      const paused = await createDoc(orgA, { title: 'paused', active: false })
      expect(paused.status).toBe('inactive')

      const future = await createDoc(orgA, {
        title: 'future',
        strategy: 'single',
        dateRange: { start: iso(60), end: iso(120) },
      })
      expect(future.status).toBe('scheduled')

      const resumed = (await payload.update({
        collection: 'maintenance',
        id: paused.id,
        data: { active: true },
        depth: 0,
      })) as Maintenance
      expect(resumed.status).toBe('under-maintenance')
    })

    it('resolves SAME_AS_SERVER through the organization timezone', async () => {
      // 02:00–03:00 every day in Asia/Tokyo (the organization's zone) = 17:00–18:00Z.
      const doc = await createDoc(orgA, {
        title: 'org tz',
        strategy: 'recurring-interval',
        timeRange: { start: '02:00', end: '03:00' },
        timezone: 'SAME_AS_SERVER',
      })
      const probe = new Date()
      probe.setUTCHours(17, 30, 0, 0)
      const { getMaintenanceStatus } = await import('@/server/maintenance/status')
      const { getOrganizationTimezone } = await import('@/server/maintenance/timezone')
      const tz = await getOrganizationTimezone(payload, orgA.id)
      expect(tz).toBe('Asia/Tokyo')
      expect(getMaintenanceStatus(doc, probe, { serverTimezone: tz })).toBe('under-maintenance')
    })

    it('rejects inconsistent schedules', async () => {
      await expect(createDoc(orgA, { title: 'no dates', strategy: 'single' })).rejects.toThrow()
      await expect(
        createDoc(orgA, {
          title: 'reversed',
          strategy: 'single',
          dateRange: { start: iso(120), end: iso(60) },
        }),
      ).rejects.toThrow()
      await expect(createDoc(orgA, { title: 'bad cron', strategy: 'cron', cron: 'nope' })).rejects.toThrow()
      await expect(
        createDoc(orgA, { title: 'no days', strategy: 'recurring-weekday', weekdays: [] }),
      ).rejects.toThrow()
      await expect(createDoc(orgA, { title: 'bad tz', timezone: 'Mars/Olympus' })).rejects.toThrow()
    })

    it('refuses monitors and status pages of another organization', async () => {
      const foreign = await createMonitor(orgB, { name: 'foreign' })
      await expect(
        createDoc(orgA, { title: 'cross-org', monitors: [foreign.id] }),
      ).rejects.toThrow(/monitors/)
      const page = await payload.create({
        collection: 'status-pages',
        data: { organization: orgB.id, title: 'B page', slug: `b-page-${run}` },
        depth: 0,
      })
      await expect(
        createDoc(orgA, { title: 'cross-org page', statusPages: [page.id] }),
      ).rejects.toThrow(/statusPages/)
    })
  })

  describe('engine integration', () => {
    it('monitors under maintenance (directly or through a parent group) get MAINTENANCE beats', async () => {
      const group = await createMonitor(orgA, { name: 'group', type: 'group' })
      const child = await createMonitor(orgA, { name: 'child', parent: group.id })
      const other = await createMonitor(orgA, { name: 'other' })
      const doc = await createDoc(orgA, { title: 'group window', monitors: [group.id] })

      expect(await isMonitorUnderMaintenance(payload, group.id)).toBe(true)
      expect(await isMonitorUnderMaintenance(payload, child.id)).toBe(true)
      expect(await isMonitorUnderMaintenance(payload, other.id)).toBe(false)

      setMaintenanceResolver(createMaintenanceResolver())
      const childBeat = await check(child.id)
      expect(childBeat.heartbeat).toMatchObject({
        status: 'maintenance',
        msg: 'Monitor under maintenance',
      })
      const groupBeat = await check(group.id)
      expect(groupBeat.heartbeat?.status).toBe('maintenance')
      const otherBeat = await check(other.id)
      expect(otherBeat.heartbeat?.status).toBe('up')

      const refreshed = await payload.findByID({ collection: 'monitors', id: child.id, depth: 0 })
      expect(refreshed.status?.lastStatus).toBe('maintenance')

      // Pausing the maintenance lifts it immediately.
      await payload.update({ collection: 'maintenance', id: doc.id, data: { active: false } })
      expect(await isMonitorUnderMaintenance(payload, child.id)).toBe(false)
      expect((await check(child.id)).heartbeat?.status).toBe('up')
    })

    it('ignores ended and scheduled windows', async () => {
      const monitor = await createMonitor(orgA, { name: 'timed' })
      await createDoc(orgA, {
        title: 'later',
        strategy: 'single',
        monitors: [monitor.id],
        dateRange: { start: iso(30), end: iso(90) },
      })
      await createDoc(orgA, {
        title: 'earlier',
        strategy: 'single',
        monitors: [monitor.id],
        dateRange: { start: iso(-90), end: iso(-30) },
      })
      expect(await isMonitorUnderMaintenance(payload, monitor.id)).toBe(false)

      await createDoc(orgA, {
        title: 'now',
        strategy: 'single',
        monitors: [monitor.id],
        dateRange: { start: iso(-5), end: iso(5) },
      })
      expect(await isMonitorUnderMaintenance(payload, monitor.id)).toBe(true)
    })
  })

  describe('status job', () => {
    it('persists statuses that changed since the last run', async () => {
      const doc = await createDoc(orgA, {
        title: 'flips',
        strategy: 'single',
        dateRange: { start: iso(60), end: iso(120) },
      })
      expect(doc.status).toBe('scheduled')

      // Move the window around "now" without the hooks recomputing the status.
      await payload.update({
        collection: 'maintenance',
        id: doc.id,
        data: { dateRange: { start: iso(-10), end: iso(10) } },
        context: { skipMaintenanceHooks: true },
        depth: 0,
      })
      expect(
        (await payload.findByID({ collection: 'maintenance', id: doc.id, depth: 0 })).status,
      ).toBe('scheduled')

      const result = await refreshMaintenanceStatuses(payload, new Date(), { emit: false })
      expect(result.changed).toBeGreaterThanOrEqual(1)
      expect(result.organizations).toContain(String(orgA.id))
      expect(
        (await payload.findByID({ collection: 'maintenance', id: doc.id, depth: 0 })).status,
      ).toBe('under-maintenance')

      const again = await refreshMaintenanceStatuses(payload, new Date(), { emit: false })
      expect(again.changed).toBe(0)
    })
  })

  describe('status pages', () => {
    it('lists running and upcoming maintenances of the page, running first', async () => {
      const page = (await payload.create({
        collection: 'status-pages',
        data: { organization: orgA.id, title: 'A page', slug: `a-page-${run}`, published: true },
        depth: 0,
      })) as StatusPage
      await createDoc(orgA, {
        title: 'soon',
        strategy: 'single',
        statusPages: [page.id],
        dateRange: { start: iso(60), end: iso(120) },
      })
      await createDoc(orgA, { title: 'running', statusPages: [page.id] })
      await createDoc(orgA, {
        title: 'far away',
        strategy: 'single',
        statusPages: [page.id],
        dateRange: { start: iso(30 * 24 * 60), end: iso(30 * 24 * 60 + 60) },
      })
      await createDoc(orgA, { title: 'elsewhere' })

      const items = await getActiveMaintenanceForStatusPage(payload, page.id)
      expect(items.map((i) => [i.title, i.status])).toEqual([
        ['running', 'under-maintenance'],
        ['soon', 'scheduled'],
      ])
      expect(items[1].start).toBeTruthy()
      expect(items[1].end).toBeTruthy()

      const { getPublicStatusPageData } = await import('@/server/status-pages/public')
      const data = await getPublicStatusPageData(payload, page.slug)
      expect(data?.maintenance.map((m) => m.title)).toEqual(['running', 'soon'])
    })
  })

  describe('route handlers', () => {
    const body = (title: string, extra: Partial<MaintenanceFormValues> = {}) => ({
      ...defaultMaintenanceValues(),
      title,
      strategy: 'manual' as const,
      ...extra,
    })

    it('schema enforces per-strategy requirements', () => {
      expect(maintenanceFormSchema.safeParse(body('ok')).success).toBe(true)
      const single = maintenanceFormSchema.safeParse({
        ...body('s'),
        strategy: 'single',
        dateRange: { start: '', end: '' },
      })
      expect(single.error?.issues.map((i) => i.path.join('.'))).toEqual(
        expect.arrayContaining(['dateRange.start', 'dateRange.end']),
      )
      const weekday = maintenanceFormSchema.safeParse({ ...body('w'), strategy: 'recurring-weekday' })
      expect(weekday.error?.issues.map((i) => i.path.join('.'))).toContain('weekdays')
      const cron = maintenanceFormSchema.safeParse({ ...body('c'), strategy: 'cron', cron: 'x' })
      expect(cron.error?.issues.map((i) => i.path.join('.'))).toContain('cron')
      const tz = maintenanceFormSchema.safeParse({ ...body('t'), timezone: 'Nowhere/Land' })
      expect(tz.error?.issues.map((i) => i.path.join('.'))).toContain('timezone')
    })

    it('rejects anonymous, viewer and foreign requests', async () => {
      expect(
        (await createMaintenance(request('POST', body('anon')), { params: params(orgA.id) })).status,
      ).toBe(401)
      expect(
        (await createMaintenance(request('POST', body('v'), viewer), { params: params(orgA.id) }))
          .status,
      ).toBe(403)
      expect(
        (await createMaintenance(request('POST', body('o'), outsider), { params: params(orgA.id) }))
          .status,
      ).toBe(403)
      expect(
        (await listMaintenance(request('GET', undefined, outsider), { params: params(orgA.id) }))
          .status,
      ).toBe(403)
    })

    it('members create, everyone in the organization reads', async () => {
      const monitor = await createMonitor(orgA, { name: 'api monitor' })
      const res = await createMaintenance(
        request('POST', body('via api', { monitors: [String(monitor.id)] }), member),
        { params: params(orgA.id) },
      )
      expect(res.status).toBe(201)
      const created = (await res.json()) as MaintenanceSummary
      expect(created.title).toBe('via api')
      expect(created.status).toBe('under-maintenance')
      expect(created.monitors).toEqual([String(monitor.id)])
      expect(created.organizationId).toBe(String(orgA.id))

      const list = await listMaintenance(request('GET', undefined, viewer), {
        params: params(orgA.id),
      })
      expect(list.status).toBe(200)
      const { docs } = (await list.json()) as { docs: MaintenanceSummary[] }
      expect(docs.map((d) => d.id)).toContain(created.id)

      const one = await readMaintenance(request('GET', undefined, viewer), {
        params: params(orgA.id, created.id),
      })
      expect(one.status).toBe(200)
      expect(((await one.json()) as MaintenanceSummary).id).toBe(created.id)
    })

    it('answers 400 for invalid bodies and foreign monitors', async () => {
      const bad = await createMaintenance(
        request('POST', { ...body('bad'), strategy: 'cron', cron: 'nope' }, member),
        { params: params(orgA.id) },
      )
      expect(bad.status).toBe(400)
      const issues = (await bad.json()) as { errors: { data: { issues: { path: string }[] } }[] }
      expect(issues.errors[0].data.issues.map((i) => i.path)).toContain('cron')

      const foreign = await createMonitor(orgB, { name: 'foreign api' })
      const crossOrg = await createMaintenance(
        request('POST', body('cross', { monitors: [String(foreign.id)] }), member),
        { params: params(orgA.id) },
      )
      expect(crossOrg.status).toBe(400)
    })

    it('updates, pauses, resumes and deletes with the right roles', async () => {
      const res = await createMaintenance(request('POST', body('lifecycle'), member), {
        params: params(orgA.id),
      })
      const created = (await res.json()) as MaintenanceSummary

      const renamed = await updateMaintenance(request('PATCH', { title: 'renamed' }, member), {
        params: params(orgA.id, created.id),
      })
      expect(renamed.status).toBe(200)
      expect(((await renamed.json()) as MaintenanceSummary).title).toBe('renamed')

      const toSingle = await updateMaintenance(
        request(
          'PATCH',
          { strategy: 'single', dateRange: { start: iso(60), end: iso(120) }, timezone: 'UTC' },
          member,
        ),
        { params: params(orgA.id, created.id) },
      )
      expect(toSingle.status).toBe(200)
      expect(((await toSingle.json()) as MaintenanceSummary).status).toBe('scheduled')

      const invalid = await updateMaintenance(
        request('PATCH', { dateRange: { start: iso(120), end: iso(60) } }, member),
        { params: params(orgA.id, created.id) },
      )
      expect(invalid.status).toBe(400)

      expect(
        (
          await updateMaintenance(request('PATCH', { title: 'nope' }, viewer), {
            params: params(orgA.id, created.id),
          })
        ).status,
      ).toBe(403)

      const paused = await pauseMaintenance(request('POST', undefined, member), {
        params: params(orgA.id, created.id),
      })
      expect(paused.status).toBe(200)
      expect((await paused.json()) as MaintenanceSummary).toMatchObject({
        active: false,
        status: 'inactive',
      })
      const resumed = await resumeMaintenance(request('POST', undefined, member), {
        params: params(orgA.id, created.id),
      })
      expect(((await resumed.json()) as MaintenanceSummary).active).toBe(true)

      // Other organizations: 404 through their own route, 403 through ours.
      expect(
        (
          await readMaintenance(request('GET', undefined, outsider), {
            params: params(orgB.id, created.id),
          })
        ).status,
      ).toBe(404)
      expect(
        (
          await readMaintenance(request('GET', undefined, outsider), {
            params: params(orgA.id, created.id),
          })
        ).status,
      ).toBe(403)

      expect(
        (
          await deleteMaintenance(request('DELETE', undefined, viewer), {
            params: params(orgA.id, created.id),
          })
        ).status,
      ).toBe(403)
      const deleted = await deleteMaintenance(request('DELETE', undefined, member), {
        params: params(orgA.id, created.id),
      })
      expect(deleted.status).toBe(200)
      expect(
        (
          await readMaintenance(request('GET', undefined, member), {
            params: params(orgA.id, created.id),
          })
        ).status,
      ).toBe(404)
    })
  })
})
