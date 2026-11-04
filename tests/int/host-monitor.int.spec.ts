/**
 * Host monitors (#136): the agent endpoint (token auth, pause, validation, rate limit), the rollups
 * it writes, and the periodic check that turns them into heartbeats (thresholds with and without a
 * duration, the grace period for a silent agent) through the real engine path, down to the
 * notification a disk threshold sends.
 */
import { getPayload, type Payload, type RequiredDataFromCollectionSlug } from 'payload'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import config from '@payload-config'
import { POST as metricsRoute } from '@/app/api/agent/v1/metrics/route'
import { DEFAULT_HOST_THRESHOLDS, type HostSample } from '@/lib/host-metrics'
import { defaultMonitorValues } from '@/lib/validation/monitor'
import { monitorFormSchema } from '@/lib/validation/monitor-schema'
import type { Heartbeat, Monitor, Notification, Organization } from '@/payload-types'
import {
  clearHeartbeatListeners,
  processCheckJob,
  registerHeartbeatListener,
  type ChecksQueue,
  type HeartbeatEvent,
} from '@/server/engine'
import { ingestHostSample } from '@/server/host-metrics/ingest'
import { enqueueNotificationsForHeartbeat, type NotificationsQueue } from '@/server/notifications'
import { runRetention } from '@/server/jobs/retention'

let payload: Payload
let org: Organization
const run = Date.now().toString(36)

const GiB = 1024 ** 3
const sample = (data: Partial<HostSample> = {}): HostSample => ({
  hostname: 'web-1',
  platform: 'linux',
  os: 'Debian GNU/Linux 12',
  uptime: 3600,
  cpus: 4,
  cpu: 12,
  load: [0.4, 0.3, 0.2],
  memory: { used: 4 * GiB, total: 16 * GiB },
  swap: { used: 0, total: 2 * GiB },
  disks: [{ mount: '/', used: 50, total: 100 }],
  network: { rx: 1000, tx: 500 },
  temperatures: [],
  ...data,
})

const fakeQueue = () =>
  ({
    upsertJobScheduler: vi.fn(async () => undefined),
    removeJobScheduler: vi.fn(async () => true),
  }) as unknown as ChecksQueue

async function createMonitor(data: Partial<Monitor> = {}): Promise<Monitor> {
  return (await payload.create({
    collection: 'monitors',
    overrideAccess: true,
    depth: 0,
    context: { skipEngineSync: true },
    data: {
      organization: org.id,
      name: `Host ${run}`,
      type: 'host',
      interval: 60,
      retryInterval: 60,
      maxRetries: 0,
      resendInterval: 0,
      hostThresholds: [
        { metric: 'disk', target: null, operator: '>', value: 90, duration: 0, severity: 'down' },
      ],
      ...data,
    } as RequiredDataFromCollectionSlug<'monitors'>,
  })) as Monitor
}

async function check(monitor: Monitor): Promise<{ heartbeat: Heartbeat; notify: boolean }> {
  const result = await processCheckJob(
    payload,
    { data: { monitorId: String(monitor.id) } },
    { queue: fakeQueue() },
  )
  expect(result.outcome).toBe('processed')
  if (result.outcome !== 'processed') throw new Error('not processed')
  return { heartbeat: result.heartbeat as Heartbeat, notify: Boolean(result.next?.notify) }
}

const post = (token: string | null, body: unknown, ip = '10.0.0.1') =>
  metricsRoute(
    new Request('http://localhost:3000/api/agent/v1/metrics', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': ip,
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  )

const rowsOf = async (monitor: Monitor) =>
  (
    await payload.find({
      collection: 'host-metrics',
      where: { monitor: { equals: monitor.id } },
      sort: 'granularity',
      overrideAccess: true,
      pagination: false,
    })
  ).docs

beforeAll(async () => {
  payload = await getPayload({ config })
  org = await payload.create({
    collection: 'organizations',
    data: { name: 'Host Org', slug: `host-${run}` },
    overrideAccess: true,
  })
})

afterEach(() => {
  clearHeartbeatListeners()
})

afterAll(async () => {
  if (org?.id) {
    const where = { organization: { equals: org.id } }
    for (const collection of [
      'heartbeats',
      'host-metrics',
      'stat-minutely',
      'stat-hourly',
      'stat-daily',
      'monitor-incidents',
      'monitors',
      'notifications',
    ] as const) {
      await payload.delete({ collection, where, overrideAccess: true })
    }
    await payload.delete({ collection: 'organizations', id: org.id, overrideAccess: true })
  }
})

describe('host monitor form', () => {
  it('starts a new host monitor with default thresholds and validates rows', () => {
    expect(defaultMonitorValues('host').hostThresholds).toEqual(DEFAULT_HOST_THRESHOLDS)
    expect(defaultMonitorValues('http').hostThresholds).toEqual([])
    const base = {
      name: 'Box',
      type: 'host',
      interval: 60,
      retryInterval: 60,
      maxRetries: 0,
      resendInterval: 0,
      timeout: 48,
    }
    expect(monitorFormSchema.parse(base).hostThresholds).toEqual([])
    expect(
      monitorFormSchema.parse({
        ...base,
        hostThresholds: [{ metric: 'disk', target: '', value: 95 }],
      }).hostThresholds,
    ).toEqual([
      { metric: 'disk', target: null, operator: '>', value: 95, duration: 0, severity: 'down' },
    ])
    const bad = monitorFormSchema.safeParse({
      ...base,
      hostThresholds: [{ metric: 'disk', operator: '>', value: 'x' }],
    })
    expect(bad.success).toBe(false)
  })

  it('generates an agent token for host monitors', async () => {
    const monitor = await createMonitor({ name: `token ${run}` })
    expect(monitor.pushToken).toMatch(/^[0-9a-f]{32}$/)
  })
})

describe('POST /api/agent/v1/metrics', () => {
  it('refuses missing and unknown tokens, and tokens of other monitor types', async () => {
    expect((await post(null, sample())).status).toBe(401)
    expect((await post('nope-nope-nope', sample())).status).toBe(401)
    const push = await createMonitor({ name: `push ${run}`, type: 'push' } as Partial<Monitor>)
    expect((await post(push.pushToken!, sample())).status).toBe(401)
  })

  it('stores a sample in the minutely, hourly and daily rollups and answers the interval', async () => {
    const monitor = await createMonitor({ name: `ingest ${run}`, interval: 30 })
    const res = await post(monitor.pushToken!, sample())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, interval: 30 })
    await post(monitor.pushToken!, sample({ cpu: 30 }))

    const rows = await rowsOf(monitor)
    expect(rows.map((r) => r.granularity).sort()).toEqual(['day', 'hour', 'minute'])
    for (const row of rows) {
      const series = row.series as Record<string, number[]>
      expect(series.cpu).toEqual([2, 42, 12, 30, 30])
      expect(series['disk:/']).toEqual([2, 100, 50, 50, 50])
      expect(series.memory[4]).toBe(25)
    }
    const minute = rows.find((r) => r.granularity === 'minute')!
    expect(minute.latest).toMatchObject({ hostname: 'web-1', cpu: 30 })
    expect(rows.find((r) => r.granularity === 'hour')!.latest ?? null).toBeNull()
  })

  it('rejects malformed samples and answers 409 while the monitor is paused', async () => {
    const monitor = await createMonitor({ name: `invalid ${run}` })
    expect((await post(monitor.pushToken!, 'not json')).status).toBe(400)
    const invalid = await post(monitor.pushToken!, { hostname: 'x', cpu: 'high' })
    expect(invalid.status).toBe(400)
    expect((await invalid.json()).error).toMatch(/^cpu:/)

    await payload.update({
      collection: 'monitors',
      id: monitor.id,
      data: { active: false },
      overrideAccess: true,
      context: { skipEngineSync: true },
    })
    expect((await post(monitor.pushToken!, sample())).status).toBe(409)
    expect(await rowsOf(monitor)).toHaveLength(0)
  })

  it('rate limits each monitor', async () => {
    const monitor = await createMonitor({ name: `limited ${run}` })
    const statuses: number[] = []
    // Rejected bodies spend points too; the default limit is 30 per minute.
    for (let i = 0; i < 31; i++) statuses.push((await post(monitor.pushToken!, '{}')).status)
    expect(statuses.slice(0, 30).every((s) => s === 400)).toBe(true)
    const limited = await post(monitor.pushToken!, sample())
    expect(limited.status).toBe(429)
    expect(limited.headers.get('retry-after')).toMatch(/^\d+$/)
  })
})

describe('host check', () => {
  it('waits for the first sample, then reports the host', async () => {
    const monitor = await createMonitor({ name: `first ${run}` })
    expect((await check(monitor)).heartbeat).toMatchObject({
      status: 'pending',
      msg: 'Waiting for the first metrics from the host agent',
    })
    await ingestHostSample(payload, monitor, sample())
    expect((await check(monitor)).heartbeat).toMatchObject({
      status: 'up',
      msg: 'CPU 12 %, memory 25 %, disk / 50 %',
    })
  })

  it('crossing a disk threshold marks the monitor DOWN and sends a notification', async () => {
    const hook = (await payload.create({
      collection: 'notifications',
      overrideAccess: true,
      data: {
        organization: org.id,
        name: `hook-${run}`,
        type: 'webhook',
        config: { url: 'https://example.com/hook' },
        active: true,
      } as never,
    })) as Notification
    const monitor = await createMonitor({
      name: `disk ${run}`,
      notifications: [hook.id] as never,
    })
    await ingestHostSample(payload, monitor, sample())
    expect((await check(monitor)).heartbeat.status).toBe('up')

    const events: HeartbeatEvent[] = []
    registerHeartbeatListener((event) => {
      events.push(event)
    })
    await ingestHostSample(
      payload,
      monitor,
      sample({ disks: [{ mount: '/', used: 93, total: 100 }] }),
    )
    const { heartbeat, notify } = await check(monitor)
    expect(heartbeat).toMatchObject({ status: 'down', msg: 'disk / at 93 % (> 90 %)' })
    expect(notify).toBe(true)

    const event = events.find((e) => String(e.heartbeat.id) === String(heartbeat.id))!
    expect(event.notify).toBe(true)
    const added: { data: Record<string, unknown> }[] = []
    const queue = {
      getJob: vi.fn(async () => undefined),
      addBulk: vi.fn(async (jobs: { data: Record<string, unknown> }[]) => {
        added.push(...jobs)
        return []
      }),
    } as unknown as NotificationsQueue
    expect(await enqueueNotificationsForHeartbeat(event, { queue })).toEqual({
      channels: 1,
      enqueued: 1,
    })
    expect(added[0].data).toMatchObject({
      notificationId: String(hook.id),
      notificationEvent: 'down',
    })
  })

  it('marks sustained breaches of a degraded threshold as degraded', async () => {
    const monitor = await createMonitor({
      name: `cpu ${run}`,
      hostThresholds: [
        { metric: 'cpu', operator: '>', value: 90, duration: 180, severity: 'degraded' },
      ] as Monitor['hostThresholds'],
    })
    const now = Date.now()
    // Only the newest sample is hot: not sustained yet.
    await ingestHostSample(payload, monitor, sample({ cpu: 99 }), new Date(now))
    expect((await check(monitor)).heartbeat.status).toBe('up')
    for (const minutes of [5, 4, 3, 2, 1]) {
      await ingestHostSample(
        payload,
        monitor,
        sample({ cpu: 95 }),
        new Date(now - minutes * 60_000),
      )
    }
    expect((await check(monitor)).heartbeat).toMatchObject({
      status: 'degraded',
      msg: 'CPU at 99 % for 3 min (> 90 %)',
    })
  })

  it('a silent agent turns the monitor DOWN after interval plus grace', async () => {
    const monitor = await createMonitor({ name: `silent ${run}`, pushGrace: 30 })
    await ingestHostSample(payload, monitor, sample(), new Date(Date.now() - 80_000))
    // 80 s old: within 60 s + 30 s.
    expect((await check(monitor)).heartbeat.status).toBe('up')
    await payload.delete({
      collection: 'host-metrics',
      where: { monitor: { equals: monitor.id } },
      overrideAccess: true,
    })
    await ingestHostSample(payload, monitor, sample(), new Date(Date.now() - 100_000))
    const { heartbeat } = await check(monitor)
    expect(heartbeat.status).toBe('down')
    expect(heartbeat.msg).toMatch(/^No metrics received for 1\d\ds$/)
  })
})

describe('retention and cleanup', () => {
  it('prunes minutely rows after a day and deletes the rows with their monitor', async () => {
    const monitor = await createMonitor({ name: `retention ${run}` })
    await ingestHostSample(payload, monitor, sample(), new Date(Date.now() - 26 * 3600_000))
    await ingestHostSample(payload, monitor, sample())
    const before = await rowsOf(monitor)
    const result = await runRetention(payload)
    expect(result.hostMetrics).toBeGreaterThanOrEqual(1)
    const after = await rowsOf(monitor)
    expect(after.filter((r) => r.granularity === 'minute')).toHaveLength(1)
    expect(after.length).toBeLessThan(before.length)

    await payload.delete({ collection: 'monitors', id: monitor.id, overrideAccess: true })
    expect(await rowsOf(monitor)).toHaveLength(0)
  })
})
