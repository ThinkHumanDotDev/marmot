/**
 * Degraded state (#93): a successful check slower than `degradedAfter` is recorded as `degraded`,
 * through the real persistence path (heartbeats, status cache, scheduler, listeners), with retries
 * and maintenance, the notification event channels filter on, the stats rollups, groups, status
 * pages and badges.
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { getPayload, type Payload, type RequiredDataFromCollectionSlug } from 'payload'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import config from '@payload-config'
import { GET as publicRoute } from '@/app/api/status-pages/[slug]/public/route'
import { monitorFormSchema } from '@/lib/validation/monitor-schema'
import type { Heartbeat, Monitor, Notification, Organization } from '@/payload-types'
import { buildBadge } from '@/server/badges/badge'
import {
  clearHeartbeatListeners,
  processCheckJob,
  recordBeat,
  registerHeartbeatListener,
  setMaintenanceResolver,
  type ChecksQueue,
  type CheckResult,
  type HeartbeatEvent,
} from '@/server/engine'
import { STATUS_VALUES } from '@/server/metrics/prometheus'
import {
  channelAcceptsEvent,
  enqueueNotificationsForHeartbeat,
  type NotificationsQueue,
} from '@/server/notifications'
import { getStats, recordHeartbeat } from '@/server/stats/uptime-calculator'
import { badgeInput, statusPageBadgeState } from '@/server/status-pages/badge'
import { overallStatus, type PublicStatusPageData } from '@/server/status-pages/public'

let payload: Payload
let org: Organization
let server: http.Server
let port: number

const run = Date.now().toString(36)

/** Queue stub: the scheduler re-plans without Redis; upserts are recorded. */
function fakeChecksQueue() {
  const upserts: { key: string; every: number }[] = []
  const queue = {
    upsertJobScheduler: vi.fn(async (key: string, opts: { every?: number }) => {
      upserts.push({ key, every: opts.every ?? 0 })
    }),
    removeJobScheduler: vi.fn(async () => true),
  } as unknown as ChecksQueue
  return { queue, upserts }
}

/** Notifications queue stub: records the jobs the dispatcher would add. */
function fakeNotificationsQueue() {
  const added: { data: Record<string, unknown> }[] = []
  const queue = {
    getJob: vi.fn(async () => undefined),
    addBulk: vi.fn(async (jobs: { data: Record<string, unknown> }[]) => {
      added.push(...jobs)
      return []
    }),
  } as unknown as NotificationsQueue
  return { queue, added }
}

async function createMonitor(data: Partial<Monitor> & { name: string }): Promise<Monitor> {
  return (await payload.create({
    collection: 'monitors',
    overrideAccess: true,
    depth: 0,
    data: {
      organization: org.id,
      type: 'http',
      url: `http://127.0.0.1:${port}/`,
      interval: 60,
      retryInterval: 20,
      maxRetries: 0,
      resendInterval: 0,
      timeout: 5,
      degradedAfter: 200,
      ...data,
    } as RequiredDataFromCollectionSlug<'monitors'>,
  })) as Monitor
}

const reload = async (id: string | number) =>
  (await payload.findByID({
    collection: 'monitors',
    id,
    depth: 0,
    overrideAccess: true,
  })) as Monitor

const ok = (ping: number, msg = '200 - OK'): CheckResult => ({ ok: true, status: 'up', msg, ping })
const fail = (msg = 'connect ECONNREFUSED'): CheckResult => ({ ok: false, msg })

/** Record a synthetic check result through the worker's persistence path, re-reading the monitor. */
async function beat(monitor: Monitor, result: CheckResult, queue?: ChecksQueue) {
  const fresh = await reload(monitor.id)
  return recordBeat(payload, fresh, result, { queue: queue ?? fakeChecksQueue().queue })
}

beforeAll(async () => {
  payload = await getPayload({ config })
  org = await payload.create({
    collection: 'organizations',
    data: { name: 'Degraded Org', slug: `degraded-${run}` },
  })
  server = http.createServer((req, res) => {
    const delay = req.url === '/slow' ? 400 : 0
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('ok')
    }, delay)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as AddressInfo).port
})

afterAll(async () => {
  setMaintenanceResolver(null)
  server?.closeAllConnections()
  await new Promise((resolve) => server?.close(resolve))
  if (org?.id) {
    const where = { organization: { equals: org.id } }
    for (const collection of [
      'status-pages',
      'heartbeats',
      'stat-minutely',
      'stat-hourly',
      'stat-daily',
      'monitors',
      'notifications',
    ] as const) {
      await payload.delete({ collection, where, overrideAccess: true })
    }
  }
})

afterEach(() => {
  clearHeartbeatListeners()
  setMaintenanceResolver(null)
})

describe('degraded checks through the worker', () => {
  it('a real slow HTTP check is DEGRADED, a fast one UP, with the transition announced', async () => {
    const monitor = await createMonitor({
      name: 'slow-http',
      url: `http://127.0.0.1:${port}/slow`,
    })
    const events: HeartbeatEvent[] = []
    registerHeartbeatListener((event) => {
      events.push(event)
    })

    const first = await processCheckJob(
      payload,
      { data: { monitorId: String(monitor.id) } },
      { queue: fakeChecksQueue().queue },
    )
    expect(first.heartbeat).toMatchObject({ status: 'degraded', important: true })
    expect(first.heartbeat?.ping).toBeGreaterThan(200)
    expect(first.heartbeat?.msg).toMatch(
      /^200 - OK \(response time \d+ ms exceeds the degraded threshold of 200 ms\)$/,
    )
    expect(events[0]).toMatchObject({ isFirstBeat: true, notify: false, notificationEvent: null })
    expect((await reload(monitor.id)).status).toMatchObject({
      lastStatus: 'degraded',
      settledStatus: 'degraded',
      retries: 0,
    })

    await payload.update({
      collection: 'monitors',
      id: monitor.id,
      data: { url: `http://127.0.0.1:${port}/` },
      overrideAccess: true,
      context: { skipEngineSync: true },
    })
    const second = await processCheckJob(
      payload,
      { data: { monitorId: String(monitor.id) } },
      { queue: fakeChecksQueue().queue },
    )
    expect(second.heartbeat).toMatchObject({ status: 'up', important: true })
    expect(events[1]).toMatchObject({
      previousStatus: 'degraded',
      notify: true,
      notificationEvent: 'degraded',
    })
  })

  it('UP -> DEGRADED -> DOWN -> DEGRADED -> UP: every change is important with the right event', async () => {
    const monitor = await createMonitor({ name: 'transitions' })
    await beat(monitor, ok(50))
    const steps: [CheckResult, string, string | null][] = [
      [ok(500), 'degraded', 'degraded'],
      [ok(600), 'degraded', null],
      [fail(), 'down', 'down'],
      [ok(700), 'degraded', 'up'],
      [ok(80), 'up', 'degraded'],
      [ok(90), 'up', null],
    ]
    for (const [result, status, event] of steps) {
      const { heartbeat, next } = await beat(monitor, result)
      expect({ status: heartbeat.status, event: next.notificationEvent }).toEqual({ status, event })
      expect(heartbeat.important).toBe(event !== null)
    }
    const important = await payload.find({
      collection: 'heartbeats',
      where: { and: [{ monitor: { equals: monitor.id } }, { important: { equals: true } }] },
      sort: 'time',
      overrideAccess: true,
    })
    expect(important.docs.map((doc) => doc.status)).toEqual([
      'up',
      'degraded',
      'down',
      'degraded',
      'up',
    ])
  })

  it('retries: DEGRADED -> PENDING (retryInterval) -> UP announces the recovery; -> DOWN after the retries', async () => {
    const monitor = await createMonitor({ name: 'retries', maxRetries: 1 })
    await beat(monitor, ok(50))
    await beat(monitor, ok(500))

    const { queue, upserts } = fakeChecksQueue()
    const pending = await beat(monitor, fail(), queue)
    expect(pending.heartbeat).toMatchObject({ status: 'pending', important: false, retries: 1 })
    expect(pending.next.notify).toBe(false)
    expect(upserts.at(-1)?.every).toBe(20_000)
    expect((await reload(monitor.id)).status).toMatchObject({
      lastStatus: 'pending',
      settledStatus: 'degraded',
    })

    const recovered = await beat(monitor, ok(60), queue)
    expect(recovered.heartbeat).toMatchObject({ status: 'up', important: true, retries: 0 })
    expect(recovered.next.notificationEvent).toBe('degraded')
    expect(upserts.at(-1)?.every).toBe(60_000)

    // Slow again, then failing past the retries: PENDING (silent) and DOWN (down event).
    await beat(monitor, ok(500))
    expect((await beat(monitor, fail())).heartbeat.status).toBe('pending')
    const down = await beat(monitor, fail())
    expect(down.heartbeat).toMatchObject({ status: 'down', important: true })
    expect(down.next.notificationEvent).toBe('down')
  })

  it('maintenance overrides the threshold; leaving it slowly is a degraded transition', async () => {
    const monitor = await createMonitor({
      name: 'maintenance',
      url: `http://127.0.0.1:${port}/slow`,
    })
    const runJob = () =>
      processCheckJob(
        payload,
        { data: { monitorId: String(monitor.id) } },
        { queue: fakeChecksQueue().queue },
      )
    expect((await runJob()).heartbeat?.status).toBe('degraded')

    setMaintenanceResolver(() => true)
    const during = await runJob()
    expect(during.heartbeat).toMatchObject({ status: 'maintenance', important: true })
    expect(during.next?.notify).toBe(false)

    setMaintenanceResolver(null)
    const after = await runJob()
    expect(after.heartbeat).toMatchObject({ status: 'degraded', important: true })
    expect(after.next?.notificationEvent).toBe('degraded')
  })

  it('upside down and types without response times ignore the threshold', async () => {
    const flipped = await createMonitor({ name: 'flipped', upsideDown: true })
    expect((await beat(flipped, fail())).heartbeat.status).toBe('up')
    expect((await beat(flipped, ok(900))).heartbeat.status).toBe('down')

    const manual = await createMonitor({ name: 'manual', type: 'manual', manualStatus: 'up' })
    expect((await beat(manual, ok(900))).heartbeat.status).toBe('up')
  })

  it('a group is DEGRADED while a child is degraded and none is worse', async () => {
    const group = await createMonitor({ name: 'group', type: 'group', url: null })
    const child = await createMonitor({ name: 'child', parent: group.id })
    await beat(child, ok(900))
    const result = await processCheckJob(
      payload,
      { data: { monitorId: String(group.id) } },
      { queue: fakeChecksQueue().queue },
    )
    expect(result.heartbeat).toMatchObject({
      status: 'degraded',
      msg: 'Degraded child monitors: child',
    })
  })
})

describe('notification events', () => {
  async function channel(name: string): Promise<Notification> {
    return (await payload.create({
      collection: 'notifications',
      overrideAccess: true,
      data: {
        organization: org.id,
        name: `${name}-${run}`,
        type: 'webhook',
        config: { url: 'https://example.com/hook' },
        active: true,
      } as never,
    })) as Notification
  }

  it('degraded is opt-in: no channel receives it by default, down/up/reminder go out as before', async () => {
    const hook = await channel('hook')
    const monitor = await createMonitor({ name: 'notified', notifications: [hook.id] as never })
    const heartbeat = (await payload.create({
      collection: 'heartbeats',
      overrideAccess: true,
      data: {
        monitor: monitor.id,
        organization: org.id,
        status: 'degraded',
        msg: 'slow',
        time: new Date().toISOString(),
      } as never,
    })) as Heartbeat

    const event = { payload, monitor, heartbeat, organizationId: org.id }
    const degraded = fakeNotificationsQueue()
    expect(
      await enqueueNotificationsForHeartbeat(
        { ...event, notificationEvent: 'degraded' },
        { queue: degraded.queue },
      ),
    ).toEqual({ channels: 0, enqueued: 0 })
    expect(degraded.added).toHaveLength(0)

    for (const name of ['down', 'up', 'reminder'] as const) {
      const sent = fakeNotificationsQueue()
      expect(
        await enqueueNotificationsForHeartbeat(
          { ...event, notificationEvent: name },
          { queue: sent.queue },
        ),
      ).toEqual({ channels: 1, enqueued: 1 })
      expect(sent.added[0].data).toMatchObject({
        notificationId: String(hook.id),
        notificationEvent: name,
      })
    }

    expect(channelAcceptsEvent(hook, 'degraded')).toBe(false)
    expect(channelAcceptsEvent(hook, undefined)).toBe(true)
  })
})

describe('statistics', () => {
  it('counts degraded checks separately, as up, with their ping in the average', async () => {
    const monitor = await createMonitor({ name: 'stats' })
    const time = new Date()
    for (const [status, ping] of [
      ['up', 100],
      ['degraded', 500],
      ['degraded', 600],
      ['down', null],
    ] as const) {
      await recordHeartbeat(payload, {
        monitorId: monitor.id,
        organizationId: org.id,
        status,
        ping,
        time,
      })
    }
    for (const collection of ['stat-minutely', 'stat-hourly', 'stat-daily'] as const) {
      const { docs } = await payload.find({
        collection,
        where: { monitor: { equals: monitor.id } },
        overrideAccess: true,
      })
      expect(docs).toHaveLength(1)
      expect(docs[0]).toMatchObject({ up: 3, down: 1, ping: 400 })
      expect(docs[0].extras).toMatchObject({ degraded: 2, pingCount: 3 })
    }
    const stats = await getStats(payload, monitor.id, '24h', { now: time })
    expect(stats).toMatchObject({ uptime: 0.75, avgPing: 400, degraded: 2 })
  })
})

describe('status pages, badges and metrics', () => {
  async function fetchPublic(slug: string): Promise<PublicStatusPageData> {
    const res = await publicRoute(new Request('http://localhost/api/status-pages/x/public'), {
      params: Promise.resolve({ slug }),
    })
    expect(res.status).toBe(200)
    return (await res.json()) as PublicStatusPageData
  }

  it('a degraded monitor reads as degraded performance on the page and its badge', async () => {
    const lastCheckAt = new Date().toISOString()
    const fast = await createMonitor({
      name: 'page-fast',
      status: { lastStatus: 'up', lastCheckAt },
    })
    const slow = await createMonitor({
      name: 'page-slow',
      status: { lastStatus: 'degraded', lastCheckAt },
    })
    const page = await payload.create({
      collection: 'status-pages',
      overrideAccess: true,
      data: {
        organization: org.id,
        title: 'Degraded page',
        slug: `degraded-${run}`,
        published: true,
        groups: [{ name: 'Services', monitors: [{ monitor: fast.id }, { monitor: slow.id }] }],
      },
    })

    const data = await fetchPublic(page.slug)
    expect(data.overall).toBe('degraded')
    const rows = data.groups[0].monitors
    expect(rows.find((row) => row.id === String(slow.id))).toMatchObject({
      status: 'degraded',
      impact: null,
    })
    expect(data.groups[0].status).toBe('degraded')
    expect(statusPageBadgeState(badgeInput(data))).toBe('degraded')

    // A degraded monitor next to a down one is a partial outage, as for up + down.
    expect(overallStatus(['degraded', 'down'])).toBe('partial')
    expect(overallStatus(['degraded', 'maintenance'])).toBe('maintenance')
  })

  it('the monitor badge and Prometheus have a value for degraded', () => {
    expect(buildBadge('status', { status: 'degraded' }, {})).toMatchObject({ message: 'Degraded' })
    expect(
      buildBadge(
        'status',
        { status: 'degraded' },
        { degradedLabel: 'Slow', degradedColor: '#fa0' },
      ),
    ).toMatchObject({ message: 'Slow', color: '#fa0' })
    expect(STATUS_VALUES.degraded).toBe(4)
  })
})

describe('monitor form', () => {
  it('accepts a threshold and clears it to null', () => {
    const base = {
      name: 'form',
      type: 'http',
      url: 'https://example.com',
      interval: 60,
      retryInterval: 60,
      maxRetries: 0,
      resendInterval: 0,
      timeout: 48,
    }
    const set = monitorFormSchema.safeParse({ ...base, degradedAfter: 1500 })
    expect(set.success && set.data.degradedAfter).toBe(1500)
    const cleared = monitorFormSchema.safeParse({ ...base, degradedAfter: undefined })
    expect(cleared.success && cleared.data.degradedAfter).toBeNull()
    expect(monitorFormSchema.safeParse({ ...base, degradedAfter: -1 }).success).toBe(false)
  })
})
