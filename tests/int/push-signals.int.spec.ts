import { getPayload, type Payload, type RequiredDataFromCollectionSlug } from 'payload'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import config from '@payload-config'
import { POST as pushRoute } from '@/app/api/push/[token]/route'
import { POST as signalRoute } from '@/app/api/push/[token]/[signal]/route'
import { monitorFormSchema } from '@/lib/validation/monitor-schema'
import { defaultMonitorValues } from '@/lib/validation/monitor'
import type { Heartbeat, Monitor, Organization, PushEvent } from '@/payload-types'
import { processCheckJob, syncMonitor, type ChecksQueue } from '@/server/engine'
import { resetOrganizationTimezoneCache } from '@/server/maintenance/timezone'
import { prunePushEvents } from '@/server/push'

let payload: Payload
let org: Organization
const run = Date.now().toString(36)

/** Queue stub: the check jobs are run by hand, never through Redis. */
function fakeQueue() {
  const upserts: { key: string; every: number }[] = []
  const queue = {
    upsertJobScheduler: vi.fn(async (key: string, opts: { every?: number }) => {
      upserts.push({ key, every: opts.every ?? 0 })
    }),
    removeJobScheduler: vi.fn(async () => true),
  } as unknown as ChecksQueue
  return { queue, upserts }
}
const { queue } = fakeQueue()

/** Freeze `Date` (only `Date`: timers keep running so the database drivers work). */
const setNow = (iso: string) => vi.setSystemTime(new Date(iso))

async function createPushMonitor(extra: Partial<Monitor> = {}) {
  return (await payload.create({
    collection: 'monitors',
    overrideAccess: true,
    depth: 0,
    data: {
      organization: org.id,
      name: `push-${run}`,
      type: 'push',
      interval: 3600,
      retryInterval: 60,
      maxRetries: 0,
      resendInterval: 0,
      timeout: 5,
      ...extra,
    } as RequiredDataFromCollectionSlug<'monitors'>,
  })) as Monitor
}

const reload = (monitor: Monitor) =>
  payload.findByID({
    collection: 'monitors',
    id: monitor.id,
    depth: 0,
    overrideAccess: true,
  }) as Promise<Monitor>

async function beatsOf(monitor: Monitor): Promise<Heartbeat[]> {
  const { docs } = await payload.find({
    collection: 'heartbeats',
    where: { monitor: { equals: monitor.id } },
    sort: 'time',
    depth: 0,
    limit: 200,
    overrideAccess: true,
  })
  return docs as Heartbeat[]
}

async function eventsOf(monitor: Monitor): Promise<PushEvent[]> {
  const { docs } = await payload.find({
    collection: 'push-events',
    where: { monitor: { equals: monitor.id } },
    sort: 'time',
    depth: 0,
    limit: 200,
    overrideAccess: true,
  })
  return docs as PushEvent[]
}

const check = async (monitor: Monitor) =>
  (await processCheckJob(payload, { data: { monitorId: String(monitor.id) } }, { queue }))
    .heartbeat!

/** Call the push endpoint: `signal` undefined is the bare token URL. */
function push(
  monitor: Monitor,
  signal?: string,
  query = '',
  init: { method?: string; body?: string } = {},
) {
  const token = monitor.pushToken!
  const path = signal === undefined ? token : `${token}/${signal}`
  const request = new Request(`http://localhost/api/push/${path}${query}`, {
    method: init.method ?? 'POST',
    body: init.body,
  })
  return signal === undefined
    ? pushRoute(request, { params: Promise.resolve({ token }) })
    : signalRoute(request, { params: Promise.resolve({ token, signal }) })
}

describe('push monitors: schedules, grace periods and signals', () => {
  beforeAll(async () => {
    payload = await getPayload({ config })
    org = await payload.create({
      collection: 'organizations',
      data: {
        name: 'Push signals',
        slug: `push-signals-${run}`,
        settings: { timezone: 'Europe/Berlin' },
      },
    })
    resetOrganizationTimezoneCache()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  afterAll(async () => {
    vi.useRealTimers()
    if (org) {
      await payload.delete({
        collection: 'monitors',
        where: { organization: { equals: org.id } },
        overrideAccess: true,
      })
      await payload.delete({ collection: 'organizations', where: { id: { equals: org.id } } })
    }
  })

  it('cron 0 2 * * * in the organization zone with 30 min grace: DOWN at 02:31, UP after the ping', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    setNow('2026-03-10T11:00:00Z')
    const monitor = await createPushMonitor({
      pushSchedule: 'cron',
      pushCron: '0 2 * * *',
      pushGrace: 30 * 60,
    })
    expect(monitor.pushTimezone).toBe('SAME_AS_SERVER')

    // Checked every minute, whatever `interval` says.
    const sched = fakeQueue()
    await syncMonitor(monitor, sched.queue)
    expect(sched.upserts[0].every).toBe(60_000)

    expect(await check(monitor)).toMatchObject({ status: 'pending' })
    setNow('2026-03-11T01:29:00Z') // 02:29 CET
    expect((await check(monitor)).status).toBe('pending')
    setNow('2026-03-11T01:31:00Z') // 02:31 CET
    expect(await check(monitor)).toMatchObject({
      status: 'down',
      msg: 'No heartbeat in the time window',
    })

    setNow('2026-03-11T01:40:00Z')
    expect((await push(monitor)).status).toBe(200)
    setNow('2026-03-11T01:45:00Z')
    expect((await check(monitor)).status).toBe('up')
    // Next night: due at 02:00 CET, DOWN after 02:30.
    setNow('2026-03-12T01:29:00Z')
    expect((await check(monitor)).status).toBe('up')
    setNow('2026-03-12T01:31:00Z')
    expect((await check(monitor)).status).toBe('down')
  })

  it('cron in an explicit zone across the spring DST change', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    setNow('2026-03-28T00:10:00Z')
    const monitor = await createPushMonitor({
      pushSchedule: 'cron',
      pushCron: '0 2 * * *',
      pushTimezone: 'Europe/Berlin',
      pushGrace: 30 * 60,
    })
    setNow('2026-03-28T01:05:00Z') // 02:05 CET
    await push(monitor)
    // 2026-03-29 02:00 does not exist in Berlin: the run is due at 03:00 CEST (01:00Z).
    setNow('2026-03-29T01:29:00Z')
    expect((await check(monitor)).status).toBe('up')
    setNow('2026-03-29T01:31:00Z')
    expect((await check(monitor)).status).toBe('down')
  })

  it('start → success records the run duration as ping; the bare URL behaves as before', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    setNow('2026-05-01T10:00:00Z')
    const monitor = await createPushMonitor({ pushGrace: 600 })

    const start = await push(monitor, 'start', '?msg=backup%20started')
    expect(start.status).toBe(200)
    expect(start.headers.get('Ping-Body-Limit')).toBe('10000')
    expect(await beatsOf(monitor)).toHaveLength(0)
    expect((await reload(monitor)).status?.pushRuns).toEqual([
      { rid: null, startedAt: '2026-05-01T10:00:00.000Z' },
    ])

    setNow('2026-05-01T10:05:00Z')
    expect(await check(monitor)).toMatchObject({ status: 'up', msg: 'Running for 300s' })

    setNow('2026-05-01T10:06:30Z')
    const done = await push(monitor, undefined, '?msg=done')
    expect(await done.json()).toEqual({ ok: true })
    const beats = await beatsOf(monitor)
    expect(beats.at(-1)).toMatchObject({ status: 'up', msg: 'done', ping: 390_000 })
    const fresh = await reload(monitor)
    expect(fresh.status).toMatchObject({ lastPushStatus: 'up', pushRuns: [], lastPing: 390_000 })
    expect(fresh.status?.lastPushAt).toBe('2026-05-01T10:06:30.000Z')

    const events = await eventsOf(monitor)
    expect(events.map((e) => [e.kind, e.msg, e.duration])).toEqual([
      ['start', 'backup started', null],
      ['success', 'done', 390_000],
    ])

    // An explicit ping still wins over the measured duration.
    await push(monitor, 'start')
    setNow('2026-05-01T10:07:00Z')
    await push(monitor, undefined, '?ping=12')
    expect((await beatsOf(monitor)).at(-1)?.ping).toBe(12)
  })

  it('a start without a finish goes DOWN after the grace period', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    setNow('2026-05-02T10:00:00Z')
    const monitor = await createPushMonitor({ pushGrace: 600 })
    await push(monitor)
    await push(monitor, 'start')
    setNow('2026-05-02T10:09:00Z')
    expect((await check(monitor)).status).toBe('up')
    setNow('2026-05-02T10:11:00Z')
    const late = await check(monitor)
    expect(late.status).toBe('down')
    expect(late.msg).toContain('did not finish within the grace period')
    // The run finally reports: UP again, the duration is recorded.
    setNow('2026-05-02T10:12:00Z')
    await push(monitor)
    expect((await beatsOf(monitor)).at(-1)).toMatchObject({ status: 'up', ping: 720_000 })
    expect((await check(monitor)).status).toBe('up')
  })

  it('fail, exit codes and rid pairing of overlapping runs', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    setNow('2026-05-03T10:00:00Z')
    const monitor = await createPushMonitor({ pushGrace: 3600 })
    await push(monitor, 'start', '?rid=a')
    setNow('2026-05-03T10:01:00Z')
    await push(monitor, 'start', '?rid=b')
    setNow('2026-05-03T10:02:00Z')
    await push(monitor, 'fail', '?rid=a&msg=boom')

    expect((await beatsOf(monitor)).at(-1)).toMatchObject({
      status: 'down',
      msg: 'boom',
      ping: 120_000,
    })
    expect((await reload(monitor)).status?.pushRuns).toEqual([
      { rid: 'b', startedAt: '2026-05-03T10:01:00.000Z' },
    ])
    // A failure stays DOWN until the next success, even though a run is in progress.
    setNow('2026-05-03T10:03:00Z')
    expect(await check(monitor)).toMatchObject({ status: 'down', msg: 'boom' })

    setNow('2026-05-03T10:04:00Z')
    await push(monitor, '0', '?rid=b')
    expect((await beatsOf(monitor)).at(-1)).toMatchObject({
      status: 'up',
      msg: 'OK',
      ping: 180_000,
    })
    expect((await check(monitor)).status).toBe('up')

    setNow('2026-05-03T10:05:00Z')
    await push(monitor, '3')
    expect((await beatsOf(monitor)).at(-1)).toMatchObject({ status: 'down', msg: 'Exit code 3' })
    const events = await eventsOf(monitor)
    expect(events.at(-1)).toMatchObject({ kind: 'fail', exitCode: 3, msg: 'Exit code 3' })
    expect(events.find((e) => e.kind === 'fail' && e.rid === 'a')?.duration).toBe(120_000)
  })

  it('maxDuration turns a slow success into DOWN', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    setNow('2026-05-04T10:00:00Z')
    const monitor = await createPushMonitor({ pushGrace: 3600, pushMaxDuration: 60 })
    await push(monitor, 'start')
    setNow('2026-05-04T10:02:00Z')
    await push(monitor)
    const beat = (await beatsOf(monitor)).at(-1)
    expect(beat).toMatchObject({ status: 'down', ping: 120_000 })
    expect(beat?.msg).toBe('Run took 120s, longer than the maximum duration of 60s')
  })

  it('/log stores the message and the first 10 000 bytes of the body without changing state', async () => {
    const monitor = await createPushMonitor()
    await push(monitor)
    const before = await reload(monitor)

    const body = 'x'.repeat(12_000)
    const res = await push(monitor, 'log', '?msg=progress', { body })
    expect(res.status).toBe(200)
    expect(await beatsOf(monitor)).toHaveLength(1)
    const after = await reload(monitor)
    expect(after.status?.lastPushAt).toBe(before.status?.lastPushAt)

    const log = (await eventsOf(monitor)).at(-1)!
    expect(log).toMatchObject({ kind: 'log', msg: 'progress', bodyTruncated: true, method: 'POST' })
    expect(log.body).toHaveLength(10_000)

    // Multi-byte characters cut at the limit are dropped, not mangled.
    await push(monitor, 'log', '', { body: 'é'.repeat(6000) })
    const utf8 = (await eventsOf(monitor)).at(-1)!
    expect(utf8.body).toBe('é'.repeat(5000))

    // A GET has no body.
    await push(monitor, 'log', '', { method: 'GET' })
    expect((await eventsOf(monitor)).at(-1)?.body ?? null).toBeNull()
  })

  it('rejects unknown signals, exit codes above 255 and malformed run ids', async () => {
    const monitor = await createPushMonitor()
    expect((await push(monitor, 'restart')).status).toBe(404)
    expect((await push(monitor, '256')).status).toBe(404)
    expect((await push(monitor, 'start', '?rid=' + 'a'.repeat(65))).status).toBe(400)
    expect((await push(monitor, 'start', '?rid=bad%20id')).status).toBe(400)
    expect(await eventsOf(monitor)).toHaveLength(0)
  })

  it('a reported DOWN is not overwritten by the periodic check (legacy status=down)', async () => {
    const monitor = await createPushMonitor({ interval: 60 })
    await push(monitor, undefined, '?status=down&msg=disk%20full')
    expect(await check(monitor)).toMatchObject({ status: 'down', msg: 'disk full' })
    await push(monitor)
    expect(await check(monitor)).toMatchObject({ status: 'up' })
  })

  it('keeps the newest ping log entries per monitor', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const monitor = await createPushMonitor()
    for (let i = 0; i < 5; i++) {
      setNow(`2026-05-05T10:0${i}:00Z`)
      await push(monitor, 'log', `?msg=line${i}`)
    }
    expect(await prunePushEvents(payload, monitor.id, 3)).toBe(2)
    expect((await eventsOf(monitor)).map((e) => e.msg)).toEqual(['line2', 'line3', 'line4'])
  })

  it('deleting the monitor deletes its ping log', async () => {
    const monitor = await createPushMonitor()
    await push(monitor, 'log')
    await payload.delete({ collection: 'monitors', id: monitor.id, overrideAccess: true })
    const { totalDocs } = await payload.count({
      collection: 'push-events',
      where: { monitor: { equals: monitor.id } },
      overrideAccess: true,
    })
    expect(totalDocs).toBe(0)
  })

  it('validates cron schedules in the form schema', () => {
    const base = { ...defaultMonitorValues('push'), name: 'job' }
    expect(monitorFormSchema.safeParse(base).success).toBe(true)
    const missing = monitorFormSchema.safeParse({ ...base, pushSchedule: 'cron' })
    expect(missing.success).toBe(false)
    const invalid = monitorFormSchema.safeParse({
      ...base,
      pushSchedule: 'cron',
      pushCron: '61 * * * *',
    })
    expect(invalid.error?.issues[0]?.path).toEqual(['pushCron'])
    const zone = monitorFormSchema.safeParse({
      ...base,
      pushSchedule: 'cron',
      pushCron: '0 2 * * *',
      pushTimezone: 'Mars/Olympus',
    })
    expect(zone.error?.issues[0]?.path).toEqual(['pushTimezone'])
    const ok = monitorFormSchema.safeParse({
      ...base,
      pushSchedule: 'cron',
      pushCron: '0 2 * * *',
      pushTimezone: 'Europe/Berlin',
      pushGrace: 1800,
    })
    expect(ok.data).toMatchObject({ pushCron: '0 2 * * *', pushGrace: 1800 })
  })
})
