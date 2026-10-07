import { Redis } from 'ioredis'
import { getPayload, type Payload, type RequiredDataFromCollectionSlug, type Where } from 'payload'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import config from '@payload-config'
import { addOrgMembership } from '@/access/memberships'
import type { Role } from '@/access/permissions'
import { GET as listOccurrences } from '@/app/api/orgs/[orgId]/maintenance/[id]/occurrences/route'
import { POST as postUpdate } from '@/app/api/orgs/[orgId]/maintenance/[id]/occurrences/[occurrenceId]/updates/route'
import { env } from '@/env'
import type { OccurrenceSummary } from '@/lib/maintenance-announcements'
import type {
  Maintenance,
  MaintenanceOccurrence,
  Monitor,
  Organization,
  StatusPage,
  User,
} from '@/payload-types'
import { createQueue } from '@/server/engine/queues'
import { QUEUE_NAMES } from '@/server/engine/names'
import {
  clearHeartbeatListeners,
  processCheckJob,
  setMaintenanceResolver,
  type ChecksQueue,
} from '@/server/engine'
import {
  clearMaintenanceEventListeners,
  createMaintenanceResolver,
  getActiveMaintenanceForStatusPage,
  isMonitorUnderMaintenance,
  maintenanceWakeupJobId,
  postOccurrenceUpdate,
  processMaintenanceWakeup,
  registerMaintenanceEventListener,
  resetOrganizationTimezoneCache,
  scheduleMaintenanceWakeups,
  syncMaintenanceById,
  type MaintenanceEvent,
  type MaintenanceSummary,
} from '@/server/maintenance'

let payload: Payload

const run = Date.now().toString(36)
const email = (name: string) => `${name}+mna-${run}@marmot.test`
const PASSWORD = 'password-123'
const MINUTE = 60_000
const HOUR = 60 * MINUTE

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

function request(method: string, body?: unknown, session?: Session): Request {
  return new Request('http://localhost/api/orgs/x/maintenance/y/occurrences', {
    method,
    headers: {
      Origin: env.NEXT_PUBLIC_SERVER_URL,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(session ? { cookie: session.cookie } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
}

const fakeQueue = {
  upsertJobScheduler: vi.fn(async () => undefined),
  removeJobScheduler: vi.fn(async () => true),
} as unknown as ChecksQueue

const check = (monitorId: string | number) =>
  processCheckJob(payload, { data: { monitorId: String(monitorId) } }, { queue: fakeQueue })

const iso = (offsetMs: number, from = Date.now()) => new Date(from + offsetMs).toISOString()

let org: Organization
let otherOrg: Organization
let member: Session
let viewer: Session
let outsider: Session
let events: MaintenanceEvent[] = []

async function createMonitor(name: string): Promise<Monitor> {
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
      name,
    } as RequiredDataFromCollectionSlug<'monitors'>,
  })) as Monitor
}

async function createPage(slug: string, extra: Partial<StatusPage> = {}): Promise<StatusPage> {
  return (await payload.create({
    collection: 'status-pages',
    data: { organization: org.id, title: slug, slug: `${slug}-${run}`, published: true, ...extra },
    depth: 0,
  })) as StatusPage
}

async function createDoc(data: Partial<Maintenance> & { title: string }): Promise<Maintenance> {
  return (await payload.create({
    collection: 'maintenance',
    overrideAccess: true,
    depth: 0,
    data: {
      organization: org.id,
      strategy: 'single',
      timezone: 'UTC',
      active: true,
      reminders: [],
      ...data,
    } as RequiredDataFromCollectionSlug<'maintenance'>,
  })) as Maintenance
}

async function occurrencesOf(maintenanceId: string | number): Promise<MaintenanceOccurrence[]> {
  const { docs } = await payload.find({
    collection: 'maintenance-occurrences',
    where: { maintenance: { equals: maintenanceId } },
    sort: 'start',
    depth: 0,
    limit: 0,
    pagination: false,
  })
  return docs as MaintenanceOccurrence[]
}

const statusOf = async (id: string | number) =>
  (await payload.findByID({ collection: 'maintenance', id, depth: 0 })).status

async function post(
  doc: Maintenance,
  occurrence: { id: string | number },
  body: unknown,
  session: Session = member,
) {
  return postUpdate(request('POST', body, session), {
    params: Promise.resolve({
      orgId: String(org.id),
      id: String(doc.id),
      occurrenceId: String(occurrence.id),
    }),
  })
}

const eventsOf = (doc: Maintenance, type?: MaintenanceEvent['type']) =>
  events.filter((e) => e.maintenance.id === String(doc.id) && (!type || e.type === type))

describe('maintenance announcements', () => {
  beforeAll(async () => {
    payload = await getPayload({ config })
    org = await payload.create({
      collection: 'organizations',
      data: { name: 'Mna', slug: `mna-${run}`, settings: { timezone: 'UTC' } },
    })
    otherOrg = await payload.create({
      collection: 'organizations',
      data: { name: 'Mna other', slug: `mna-other-${run}` },
    })
    member = await createMember('member', org, 'member')
    viewer = await createMember('viewer', org, 'viewer')
    outsider = await createMember('outsider', otherOrg, 'owner')
    registerMaintenanceEventListener((event) => {
      events.push(event)
    })
  })

  afterAll(async () => {
    clearMaintenanceEventListeners()
    setMaintenanceResolver(null)
    const orgIds = [org?.id, otherOrg?.id].filter(Boolean)
    if (orgIds.length) {
      const wipe = async (collection: 'maintenance' | 'status-pages' | 'monitors') => {
        const where: Where = { organization: { in: orgIds } }
        const result = await payload.delete({ collection, where, depth: 0 })
        if (result.errors.length) {
          throw new Error(`${collection} cleanup: ${JSON.stringify(result.errors)}`)
        }
      }
      await wipe('maintenance')
      await wipe('status-pages')
      await wipe('monitors')
      await payload.delete({ collection: 'organizations', where: { id: { in: orgIds } } })
    }
    await payload.delete({
      collection: 'users',
      where: { email: { like: `+mna-${run}@marmot.test` } },
    })
  })

  afterEach(() => {
    events = []
    clearHeartbeatListeners()
    setMaintenanceResolver(null)
    resetOrganizationTimezoneCache()
  })

  describe('automatic start and completion', () => {
    it('with autoComplete off, an overrunning window keeps suppressing alerts until completed', async () => {
      const monitor = await createMonitor('overrun')
      const now = Date.now()
      const doc = await createDoc({
        title: 'overrun',
        monitors: [monitor.id],
        autoComplete: false,
        dateRange: { start: iso(-10 * MINUTE, now), end: iso(10 * MINUTE, now) },
      })
      expect(doc.status).toBe('under-maintenance')
      const [occurrence] = await occurrencesOf(doc.id)
      expect(occurrence.state).toBe('in-progress')
      expect(eventsOf(doc, 'started')).toHaveLength(1)

      // Half an hour after the planned end it is still running and still suppressing.
      const later = new Date(now + 40 * MINUTE)
      const synced = await syncMaintenanceById(payload, doc.id, { now: later })
      expect(synced?.status).toBe('under-maintenance')
      expect((await occurrencesOf(doc.id))[0].state).toBe('in-progress')
      expect(await isMonitorUnderMaintenance(payload, monitor.id)).toBe(true)
      setMaintenanceResolver(createMaintenanceResolver())
      expect((await check(monitor.id)).heartbeat?.status).toBe('maintenance')

      // An admin marks it completed: alerts resume.
      const res = await post(doc, occurrence, { status: 'completed', message: 'All done.' })
      expect(res.status).toBe(201)
      const body = (await res.json()) as {
        occurrence: OccurrenceSummary
        maintenance: MaintenanceSummary
      }
      expect(body.occurrence.state).toBe('completed')
      expect(body.occurrence.updates[0]).toMatchObject({
        status: 'completed',
        message: 'All done.',
      })
      expect(body.maintenance.status).toBe('ended')
      expect(await statusOf(doc.id)).toBe('ended')
      expect(await isMonitorUnderMaintenance(payload, monitor.id)).toBe(false)
      expect((await check(monitor.id)).heartbeat?.status).toBe('up')
      expect(eventsOf(doc, 'completed')).toHaveLength(1)
    })

    it('with autoComplete on, the window completes at its planned end', async () => {
      const monitor = await createMonitor('on time')
      const now = Date.now()
      const doc = await createDoc({
        title: 'on time',
        monitors: [monitor.id],
        dateRange: { start: iso(-10 * MINUTE, now), end: iso(10 * MINUTE, now) },
      })
      expect(await isMonitorUnderMaintenance(payload, monitor.id)).toBe(true)
      const synced = await syncMaintenanceById(payload, doc.id, {
        now: new Date(now + 11 * MINUTE),
      })
      expect(synced?.status).toBe('ended')
      const [occurrence] = await occurrencesOf(doc.id)
      expect(occurrence.state).toBe('completed')
      expect(occurrence.updates?.map((u) => u.status)).toEqual(['in-progress', 'completed'])
      expect(await isMonitorUnderMaintenance(payload, monitor.id)).toBe(false)
    })

    it('with autoStart off, a due window waits for an admin to start it', async () => {
      const monitor = await createMonitor('manual start')
      const doc = await createDoc({
        title: 'manual start',
        monitors: [monitor.id],
        autoStart: false,
        dateRange: { start: iso(-5 * MINUTE), end: iso(30 * MINUTE) },
      })
      expect(doc.status).toBe('scheduled')
      expect(await isMonitorUnderMaintenance(payload, monitor.id)).toBe(false)
      const [occurrence] = await occurrencesOf(doc.id)
      expect(occurrence.state).toBe('scheduled')

      // Viewers may not post; impossible transitions are refused.
      expect((await post(doc, occurrence, { status: 'in-progress' }, viewer)).status).toBe(403)
      expect((await post(doc, occurrence, { status: 'completed' })).status).toBe(409)
      expect((await post(doc, occurrence, { status: 'nope' })).status).toBe(400)

      const res = await post(doc, occurrence, { status: 'in-progress' })
      expect(res.status).toBe(201)
      expect(await statusOf(doc.id)).toBe('under-maintenance')
      expect(await isMonitorUnderMaintenance(payload, monitor.id)).toBe(true)

      // Verifying keeps it running; a note keeps the state.
      await post(doc, occurrence, { status: 'verifying', message: 'Checking replicas' })
      await post(doc, occurrence, { status: 'verifying', message: '60 % verified' })
      expect(await isMonitorUnderMaintenance(payload, monitor.id)).toBe(true)
      const [after] = await occurrencesOf(doc.id)
      expect(after.state).toBe('verifying')
      expect(after.updates?.map((u) => [u.status, u.message ?? ''])).toEqual([
        ['in-progress', ''],
        ['verifying', 'Checking replicas'],
        ['verifying', '60 % verified'],
      ])
      expect(eventsOf(doc).map((e) => e.type)).toEqual([
        'scheduled',
        'started',
        'updated',
        'updated',
      ])
    })
  })

  describe('reminders', () => {
    it('sends each reminder exactly once per occurrence', async () => {
      const now = Date.now()
      const start = now + 25 * HOUR
      const doc = await createDoc({
        title: 'reminded',
        reminders: ['1440', '60'],
        dateRange: { start: iso(0, start), end: iso(HOUR, start) },
      })
      expect(eventsOf(doc, 'scheduled')).toHaveLength(1)
      expect(eventsOf(doc, 'reminder')).toHaveLength(0)

      const at = (offset: number) => new Date(start + offset)
      await syncMaintenanceById(payload, doc.id, { now: at(-24 * HOUR + MINUTE) })
      await syncMaintenanceById(payload, doc.id, { now: at(-24 * HOUR + 2 * MINUTE) })
      await syncMaintenanceById(payload, doc.id, { now: at(-12 * HOUR) })
      expect(eventsOf(doc, 'reminder').map((e) => e.reminderMinutes)).toEqual([1440])

      await syncMaintenanceById(payload, doc.id, { now: at(-59 * MINUTE) })
      await syncMaintenanceById(payload, doc.id, { now: at(-30 * MINUTE) })
      expect(eventsOf(doc, 'reminder').map((e) => e.reminderMinutes)).toEqual([1440, 60])
      const [occurrence] = await occurrencesOf(doc.id)
      expect(occurrence.remindersSent).toEqual(['60', '1440'])
      const reminder = eventsOf(doc, 'reminder')[0]
      expect(reminder.occurrence.id).toBe(String(occurrence.id))
      expect(reminder.organizationId).toBe(String(org.id))
    })

    it('skips reminders that are far overdue instead of sending them late', async () => {
      const start = Date.now() + 2 * HOUR
      const doc = await createDoc({
        title: 'late reminder',
        reminders: ['1440', '60'],
        dateRange: { start: iso(0, start), end: iso(HOUR, start) },
      })
      // Created two hours ahead: the 24 h reminder is long overdue and only recorded as handled.
      await syncMaintenanceById(payload, doc.id, { now: new Date(start - 59 * MINUTE) })
      expect(eventsOf(doc, 'reminder').map((e) => e.reminderMinutes)).toEqual([60])
      expect((await occurrencesOf(doc.id))[0].remindersSent).toEqual(['60', '1440'])
    })
  })

  describe('cancellation and status pages', () => {
    it('cancelling an upcoming occurrence notifies and shows it as cancelled', async () => {
      const monitor = await createMonitor('cancel')
      const page = await createPage('cancel-page')
      const now = Date.now()
      const doc = await createDoc({
        title: 'to cancel',
        monitors: [monitor.id],
        statusPages: [page.id],
        dateRange: { start: iso(2 * HOUR, now), end: iso(3 * HOUR, now) },
      })
      const before = await getActiveMaintenanceForStatusPage(payload, page.id)
      expect(before.map((m) => [m.title, m.status, m.state])).toEqual([
        ['to cancel', 'scheduled', 'scheduled'],
      ])

      const [occurrence] = await occurrencesOf(doc.id)
      const res = await post(doc, occurrence, {
        status: 'cancelled',
        message: 'Postponed to next week.',
      })
      expect(res.status).toBe(201)
      const cancelled = eventsOf(doc, 'cancelled')
      expect(cancelled).toHaveLength(1)
      expect(cancelled[0].maintenance.statusPages).toEqual([String(page.id)])
      expect(cancelled[0].update).toMatchObject({
        status: 'cancelled',
        message: 'Postponed to next week.',
      })

      const { getPublicStatusPageData } = await import('@/server/status-pages/public')
      const data = await getPublicStatusPageData(payload, page.slug)
      expect(data?.maintenance).toHaveLength(1)
      expect(data?.maintenance[0]).toMatchObject({
        title: 'to cancel',
        status: 'cancelled',
        state: 'cancelled',
      })
      expect(data?.maintenance[0].updates[0].message).toBe('Postponed to next week.')

      // The planned time comes: nothing starts, nothing is suppressed.
      const synced = await syncMaintenanceById(payload, doc.id, {
        now: new Date(now + 2.5 * HOUR),
      })
      expect(synced?.status).toBe('ended')
      expect((await occurrencesOf(doc.id)).map((o) => o.state)).toEqual(['cancelled'])
      expect(await isMonitorUnderMaintenance(payload, monitor.id)).toBe(false)
      expect(eventsOf(doc, 'started')).toHaveLength(0)
    })

    it('keeps finished windows on the page for the configured number of hours', async () => {
      const page = await createPage('visibility', { maintenanceVisibilityHours: 2 })
      const now = Date.now()
      const doc = await createDoc({
        title: 'finished',
        statusPages: [page.id],
        dateRange: { start: iso(-30 * MINUTE, now), end: iso(30 * MINUTE, now) },
      })
      const end = now + 30 * MINUTE
      await syncMaintenanceById(payload, doc.id, { now: new Date(end) })
      const [occurrence] = await occurrencesOf(doc.id)
      expect(occurrence.state).toBe('completed')

      const visible = await getActiveMaintenanceForStatusPage(payload, page.id, {
        now: new Date(end + HOUR),
        visibilityHours: page.maintenanceVisibilityHours,
      })
      expect(visible.map((m) => [m.title, m.status])).toEqual([['finished', 'completed']])
      expect(visible[0].updates.map((u) => u.status)).toEqual(['completed', 'in-progress'])

      const gone = await getActiveMaintenanceForStatusPage(payload, page.id, {
        now: new Date(end + 3 * HOUR),
        visibilityHours: page.maintenanceVisibilityHours,
      })
      expect(gone).toEqual([])
    })
  })

  describe('recurring windows', () => {
    it('track state and updates per occurrence', async () => {
      const monitor = await createMonitor('nightly')
      const day = 24 * HOUR
      const base = new Date()
      base.setUTCHours(0, 0, 0, 0)
      const dayStart = (n: number) => base.getTime() + n * day
      const doc = await createDoc({
        title: 'nightly',
        strategy: 'recurring-interval',
        monitors: [monitor.id],
        intervalDay: 1,
        timeRange: { start: '10:00', end: '11:00' },
        dateRange: { start: '2026-01-01T00:00', end: null },
      })

      // Day +3 at 10:30: that day's window runs.
      const first = await syncMaintenanceById(payload, doc.id, {
        now: new Date(dayStart(3) + 10.5 * HOUR),
      })
      expect(first?.status).toBe('under-maintenance')
      const occurrenceAt = async (n: number) =>
        (await occurrencesOf(doc.id)).find(
          (o) => new Date(o.start).getTime() === dayStart(n) + 10 * HOUR,
        ) as MaintenanceOccurrence
      const day3 = await occurrenceAt(3)
      expect(day3.state).toBe('in-progress')
      expect((await occurrenceAt(4)).state).toBe('scheduled')
      await postOccurrenceUpdate(payload, doc, day3, {
        status: 'in-progress',
        message: 'Night 3: reindexing',
        now: new Date(dayStart(3) + 10.6 * HOUR),
      })

      // Day +4 at 10:30: day 3 completed at its end, day 4 runs with its own timeline.
      await syncMaintenanceById(payload, doc.id, { now: new Date(dayStart(4) + 10.5 * HOUR) })
      const day4 = await occurrenceAt(4)
      expect(day4.state).toBe('in-progress')
      await postOccurrenceUpdate(payload, doc, day4, {
        status: 'in-progress',
        message: 'Night 4: vacuum',
        now: new Date(dayStart(4) + 10.6 * HOUR),
      })

      const after3 = await occurrenceAt(3)
      const after4 = await occurrenceAt(4)
      expect(after3.state).toBe('completed')
      expect(after3.updates?.map((u) => u.message ?? '')).toEqual(['', 'Night 3: reindexing', ''])
      expect(after4.updates?.map((u) => u.message ?? '')).toEqual(['', 'Night 4: vacuum'])
      expect((await occurrenceAt(5)).state).toBe('scheduled')
    })
  })

  describe('manual maintenances', () => {
    it('run as one open occurrence; completing it pauses the maintenance', async () => {
      const doc = await createDoc({ title: 'manual run', strategy: 'manual' })
      expect(doc.status).toBe('under-maintenance')
      const [occurrence] = await occurrencesOf(doc.id)
      expect(occurrence).toMatchObject({ state: 'in-progress', end: null })

      const res = await post(doc, occurrence, { status: 'completed' })
      expect(res.status).toBe(201)
      const body = (await res.json()) as { maintenance: MaintenanceSummary }
      expect(body.maintenance).toMatchObject({ active: false, status: 'inactive' })

      // Resuming starts a new run.
      await payload.update({ collection: 'maintenance', id: doc.id, data: { active: true } })
      expect((await occurrencesOf(doc.id)).map((o) => o.state)).toEqual([
        'completed',
        'in-progress',
      ])
    })
  })

  describe('routes and lifecycle', () => {
    it('lists occurrences for readers of the organization only', async () => {
      const doc = await createDoc({
        title: 'listed',
        dateRange: { start: iso(HOUR), end: iso(2 * HOUR) },
      })
      const params = (orgId: string | number) =>
        Promise.resolve({ orgId: String(orgId), id: String(doc.id) })
      const res = await listOccurrences(request('GET', undefined, viewer), {
        params: params(org.id),
      })
      expect(res.status).toBe(200)
      const { docs } = (await res.json()) as { docs: OccurrenceSummary[] }
      expect(docs.map((d) => d.state)).toEqual(['scheduled'])
      expect(docs[0].maintenanceId).toBe(String(doc.id))

      expect(
        (await listOccurrences(request('GET', undefined, outsider), { params: params(org.id) }))
          .status,
      ).toBe(403)
      expect((await listOccurrences(request('GET'), { params: params(org.id) })).status).toBe(401)
    })

    it('moves an upcoming occurrence when the schedule changes and deletes them with the maintenance', async () => {
      const doc = await createDoc({
        title: 'moved',
        dateRange: { start: iso(HOUR), end: iso(2 * HOUR) },
      })
      const [before] = await occurrencesOf(doc.id)
      const start = iso(3 * HOUR)
      await payload.update({
        collection: 'maintenance',
        id: doc.id,
        data: { dateRange: { start, end: iso(4 * HOUR) } },
      })
      const after = await occurrencesOf(doc.id)
      expect(after).toHaveLength(1)
      expect(String(after[0].id)).toBe(String(before.id))
      expect(new Date(after[0].start).getTime()).toBe(new Date(start).getTime())

      await payload.delete({ collection: 'maintenance', id: doc.id })
      expect(await occurrencesOf(doc.id)).toEqual([])
    })
  })

  describe('wake-up jobs', () => {
    it('enqueues one delayed job per future instant, and a wake-up applies the transition', async (ctx) => {
      const probe = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
        lazyConnect: true,
        connectTimeout: 2000,
        maxRetriesPerRequest: 1,
        retryStrategy: () => null,
      })
      let redisAvailable = false
      try {
        await probe.connect()
        await probe.ping()
        redisAvailable = true
      } catch {
        redisAvailable = false
      } finally {
        probe.disconnect()
      }
      if (!redisAvailable) return ctx.skip()

      const prefix = `marmot-test-${Math.random().toString(36).slice(2, 10)}`
      const queue = createQueue(QUEUE_NAMES.maintenance, { prefix })
      try {
        const now = Date.now()
        const ids = await scheduleMaintenanceWakeups(
          'm1',
          [now + HOUR, now + HOUR, now - MINUTE, now + 2 * HOUR],
          { queue, now },
        )
        expect(ids).toEqual([
          maintenanceWakeupJobId('m1', now + HOUR),
          maintenanceWakeupJobId('m1', now + 2 * HOUR),
        ])
        // Re-planning is idempotent.
        await scheduleMaintenanceWakeups('m1', [now + HOUR], { queue, now })
        expect(await queue.getDelayedCount()).toBe(2)
        const job = await queue.getJob(ids[0])
        expect(job?.data).toEqual({ maintenanceId: 'm1', at: now + HOUR })
      } finally {
        await queue.obliterate({ force: true })
        await queue.close()
      }

      // The processor evaluates at the planned instant even when it runs a little early.
      const now = Date.now()
      const doc = await createDoc({
        title: 'woken',
        dateRange: { start: iso(HOUR, now), end: iso(2 * HOUR, now) },
      })
      expect(
        await processMaintenanceWakeup(
          payload,
          { maintenanceId: String(doc.id), at: now + HOUR },
          { emit: false },
        ),
      ).toEqual({
        status: 'under-maintenance',
      })
      expect((await occurrencesOf(doc.id))[0].state).toBe('in-progress')
    })
  })
})
