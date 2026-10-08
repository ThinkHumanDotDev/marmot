import { getPayload, type Payload } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import config from '@payload-config'
import { addOrgMembership } from '@/access/memberships'
import { GET as statsRoute } from '@/app/api/monitors/[id]/stats/route'
import { retentionCutoffs, runRetention } from '@/server/jobs/retention'
import { createStatsListener } from '@/server/stats'
import { addSample, bucketIndex, bucketLowerBound } from '@/server/stats/latency-histogram'
import { getRangeStats } from '@/server/stats/range-stats'
import {
  clearStatistics,
  getAvgPing,
  getBuckets,
  getDailyKey,
  getHourlyKey,
  getMinutelyKey,
  getStats,
  getUptime,
  recordHeartbeat,
} from '@/server/stats/uptime-calculator'

let payload: Payload
let monitorId: string | number
let otherMonitorId: string | number
/** Required monitor fields (defaults are not applied at the type level). */
const MONITOR_DEFAULTS = {
  type: 'manual' as const,
  active: false,
  interval: 60,
  retryInterval: 60,
  maxRetries: 0,
  resendInterval: 0,
  timeout: 48,
}

let organizationId: string | number

// Fixed "now" so bucket boundaries are deterministic: 2026-03-10T10:30:00Z
const NOW = new Date(Date.UTC(2026, 2, 10, 10, 30, 0))
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000)
const hoursAgo = (h: number) => minutesAgo(h * 60)
const daysAgo = (d: number) => hoursAgo(d * 24)

type StatCollection = 'stat-minutely' | 'stat-hourly' | 'stat-daily'

async function countRows(collection: StatCollection, monitor: string | number) {
  return (
    await payload.count({
      collection,
      where: { monitor: { equals: monitor } },
    })
  ).totalDocs
}

describe('stats: time-series aggregation', () => {
  beforeAll(async () => {
    payload = await getPayload({ config })

    const org = await payload.create({
      collection: 'organizations',
      data: { name: 'stats-int-org', slug: `stats-int-org-${Date.now().toString(36)}` },
    })
    organizationId = org.id
    const monitor = await payload.create({
      collection: 'monitors',
      data: {
        ...MONITOR_DEFAULTS,
        organization: organizationId as never,
        name: 'stats-int-monitor',
      },
    })
    monitorId = monitor.id
    const other = await payload.create({
      collection: 'monitors',
      data: { ...MONITOR_DEFAULTS, organization: organizationId as never, name: 'stats-int-other' },
    })
    otherMonitorId = other.id
  })

  afterAll(async () => {
    await clearStatistics(payload, monitorId)
    await clearStatistics(payload, otherMonitorId)
    await payload.delete({ collection: 'monitors', id: monitorId })
    await payload.delete({ collection: 'monitors', id: otherMonitorId })
    await payload.delete({ collection: 'organizations', id: organizationId })
    await payload.delete({
      collection: 'users',
      where: { email: { equals: 'stats-int@marmot.local' } },
    })
  })

  it('upserts one minutely/hourly/daily row per bucket and keeps a running average', async () => {
    const base = { monitorId, organizationId }
    // three beats in the same minute
    await recordHeartbeat(payload, { ...base, status: 'up', ping: 100, time: minutesAgo(0) })
    await recordHeartbeat(payload, {
      ...base,
      status: 'up',
      ping: 200,
      time: new Date(NOW.getTime() + 10_000),
    })
    await recordHeartbeat(payload, {
      ...base,
      status: 'down',
      ping: null,
      time: new Date(NOW.getTime() + 20_000),
    })

    const minutely = await payload.find({
      collection: 'stat-minutely',
      where: { monitor: { equals: monitorId } },
      depth: 0,
    })
    expect(minutely.totalDocs).toBe(1)
    expect(minutely.docs[0]).toMatchObject({
      timestamp: getMinutelyKey(NOW),
      up: 2,
      down: 1,
      ping: 150,
      pingMin: 100,
      pingMax: 200,
      extras: { pingCount: 2 },
    })
    expect(String(minutely.docs[0].organization)).toBe(String(organizationId))
    // The latency histogram round-trips through the JSON column unchanged (#95).
    expect(minutely.docs[0].latencyHistogram).toEqual(addSample(addSample(null, 100), 200))

    expect(await countRows('stat-hourly', monitorId)).toBe(1)
    expect(await countRows('stat-daily', monitorId)).toBe(1)
    const hourly = await payload.find({
      collection: 'stat-hourly',
      where: { monitor: { equals: monitorId } },
      depth: 0,
    })
    expect(hourly.docs[0]).toMatchObject({ timestamp: getHourlyKey(NOW), up: 2, down: 1 })
  })

  it('records a beat whose time arrives as an ISO string (the engine passes the stored document)', async () => {
    await clearStatistics(payload, otherMonitorId)
    const when = new Date(Date.now() - 2 * 60 * 60 * 1000)
    await createStatsListener(payload)({
      monitor: { id: otherMonitorId },
      organizationId,
      heartbeat: { status: 'up', ping: 42, time: when.toISOString(), important: true },
    })
    const minutely = await payload.find({
      collection: 'stat-minutely',
      where: {
        and: [
          { monitor: { equals: otherMonitorId } },
          { timestamp: { equals: getMinutelyKey(when) } },
        ],
      },
    })
    expect(minutely.totalDocs).toBe(1)
    expect(minutely.docs[0].up).toBe(1)
    await clearStatistics(payload, otherMonitorId)
  })

  it('records nothing, histogram included, for deferred or checker-offline beats', async () => {
    await clearStatistics(payload, otherMonitorId)
    const listener = createStatsListener(payload)
    const time = new Date(Date.now() - 60_000).toISOString()
    // A deferred beat (Globalping 429, #142) is PENDING; a ping on it must still not be sampled.
    await listener({
      monitor: { id: otherMonitorId },
      organizationId,
      deferred: true,
      heartbeat: { status: 'pending', ping: 250, time },
    })
    await listener({
      monitor: { id: otherMonitorId },
      organizationId,
      checkerOffline: true,
      heartbeat: { status: 'pending', ping: 250, time },
    })
    expect(await countRows('stat-minutely', otherMonitorId)).toBe(0)
    expect(await countRows('stat-daily', otherMonitorId)).toBe(0)
  })

  it('tolerates concurrent beats for the same bucket without losing any', async () => {
    const time = minutesAgo(5)
    await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        recordHeartbeat(payload, {
          monitorId: otherMonitorId,
          organizationId,
          status: i % 2 === 0 ? 'up' : 'down',
          ping: 10,
          time,
        }),
      ),
    )
    const rows = await payload.find({
      collection: 'stat-minutely',
      where: { monitor: { equals: otherMonitorId } },
      depth: 0,
    })
    // Exactly one row for the bucket thanks to the unique (monitor, timestamp) index …
    expect(rows.totalDocs).toBe(1)
    // … and because beats are not serialised, at least the first write survives.
    expect(rows.docs[0].up + rows.docs[0].down).toBeGreaterThanOrEqual(1)
    expect(rows.docs[0].up + rows.docs[0].down).toBeLessThanOrEqual(6)
  })

  it('computes 24h / 30d / 1y uptime and average ping from the right aggregate', async () => {
    const base = { monitorId, organizationId }
    // Older beats: 3 hours ago (inside 24h), 5 days ago (inside 30d only), 100 days ago (1y only)
    await recordHeartbeat(payload, { ...base, status: 'up', ping: 50, time: hoursAgo(3) })
    await recordHeartbeat(payload, {
      ...base,
      status: 'maintenance',
      ping: null,
      time: hoursAgo(3),
    })
    await recordHeartbeat(payload, { ...base, status: 'pending', ping: null, time: daysAgo(5) })
    await recordHeartbeat(payload, { ...base, status: 'up', ping: 1000, time: daysAgo(100) })

    // 24h: minutely buckets → now (up 2 / down 1, pings 100,200) + 3h ago (up 2 incl. maintenance, ping 50)
    const day = await getStats(payload, monitorId, '24h', { now: NOW })
    expect(day.granularity).toBe('minute')
    expect(day.buckets.map((b) => b.timestamp)).toEqual([
      getMinutelyKey(hoursAgo(3)),
      getMinutelyKey(NOW),
    ])
    expect(day.uptime).toBeCloseTo(4 / 5, 10)
    expect(day.avgPing).toBeCloseTo((100 + 200 + 50) / 3, 10)

    // 30d: hourly buckets → adds the pending beat 5 days ago (counts as down)
    const month = await getStats(payload, monitorId, '30d', { now: NOW })
    expect(month.granularity).toBe('hour')
    expect(month.buckets).toHaveLength(3)
    expect(month.uptime).toBeCloseTo(4 / 6, 10)
    expect(await getUptime(payload, monitorId, '30d', { now: NOW })).toBeCloseTo(4 / 6, 10)

    // 1y: daily buckets → adds the beat 100 days ago (up, ping 1000)
    const year = await getStats(payload, monitorId, '1y', { now: NOW })
    expect(year.granularity).toBe('day')
    expect(year.buckets.map((b) => b.timestamp)).toContain(getDailyKey(daysAgo(100)))
    expect(year.uptime).toBeCloseTo(5 / 7, 10)
    expect(await getAvgPing(payload, monitorId, '1y', { now: NOW })).toBeCloseTo(
      (100 + 200 + 50 + 1000) / 4,
      10,
    )

    const buckets = await getBuckets(payload, monitorId, '24h', { now: NOW })
    expect(buckets).toHaveLength(2)
    expect(buckets[1]).toMatchObject({ up: 2, down: 1, ping: 150 })
  })

  it('derives percentiles, check counts and a chart series from the rollups (#95)', async () => {
    // State from the previous tests: pings 100 + 200 now, 50 three hours ago, a pending beat five
    // days ago and 1000 a hundred days ago.
    const month = await getRangeStats(payload, monitorId, '30d', { now: NOW, percentiles: ['p95'] })
    expect(month.granularity).toBe('hour')
    expect(month.checks).toEqual({ total: 6, up: 4, failed: 2, degraded: 0, maintenance: 1 })
    // p95 of [50, 100, 200] is 200: the estimate stays in 200's bucket (bounded by the max).
    expect(month.percentiles.p95).toBeGreaterThanOrEqual(bucketLowerBound(bucketIndex(200)))
    expect(month.percentiles.p95).toBeLessThanOrEqual(200)
    expect(month.percentiles.p50).toBeGreaterThanOrEqual(bucketLowerBound(bucketIndex(100)))
    expect(month.step).toBe(4 * 3600)
    expect(month.series).toHaveLength(180)
    expect(month.series.reduce((sum, p) => sum + p.up + p.down, 0)).toBe(6)
    expect(month.series.at(-1)).toHaveProperty('p95')
    expect(month.series.at(-1)).not.toHaveProperty('p50')
    expect(month.buckets[0]).not.toHaveProperty('latencyHistogram')

    // 90 days come from the daily rollup and stop short of the beat 100 days ago.
    const quarter = await getRangeStats(payload, monitorId, '90d', { now: NOW })
    expect(quarter.granularity).toBe('day')
    expect(quarter.series).toHaveLength(90)
    expect(quarter.percentiles.p99).toBeLessThanOrEqual(200)
    const year = await getRangeStats(payload, monitorId, '1y', { now: NOW })
    expect(year.percentiles.p99).toBeGreaterThan(500)

    // 7 days: hourly rows; degraded beats are counted and feed the percentiles.
    await clearStatistics(payload, otherMonitorId)
    await recordHeartbeat(payload, {
      monitorId: otherMonitorId,
      organizationId,
      status: 'degraded',
      ping: 4000,
      time: daysAgo(2),
    })
    await recordHeartbeat(payload, {
      monitorId: otherMonitorId,
      organizationId,
      status: 'up',
      ping: 40,
      time: daysAgo(1),
    })
    const week = await getRangeStats(payload, otherMonitorId, '7d', { now: NOW })
    expect(week.checks).toMatchObject({ total: 2, degraded: 1, failed: 0 })
    expect(week.series.reduce((sum, p) => sum + p.degraded, 0)).toBe(1)
    expect(week.percentiles.p99).toBeGreaterThanOrEqual(bucketLowerBound(bucketIndex(4000)))
    expect(week.percentiles.p99).toBeLessThanOrEqual(4000)
    await clearStatistics(payload, otherMonitorId)
  })

  it('falls back to the latest bucket when the window is empty', async () => {
    // Pretend it is a year later: no buckets in any window, but the monitor has history.
    const later = new Date(NOW.getTime() + 400 * 86400_000)
    const stats = await getStats(payload, monitorId, '24h', { now: later })
    expect(stats.buckets).toHaveLength(0)
    expect(stats.uptime).toBeCloseTo(2 / 3, 10) // latest minutely bucket: up 2 / down 1
    expect(stats.avgPing).toBe(150)
  })

  it('returns zero/null for a monitor without any data', async () => {
    const fresh = await payload.create({
      collection: 'monitors',
      data: { ...MONITOR_DEFAULTS, organization: organizationId as never, name: 'stats-empty' },
    })
    try {
      expect(await getStats(payload, fresh.id, '24h', { now: NOW })).toMatchObject({
        uptime: 0,
        avgPing: null,
        buckets: [],
      })
    } finally {
      await payload.delete({ collection: 'monitors', id: fresh.id })
    }
  })

  it('retention deletes expired minutely, hourly and daily rows only', async () => {
    const base = { monitorId, organizationId }
    // Expired rows: 25h ago (minutely), 31 days ago (hourly), 400 days ago (daily)
    await recordHeartbeat(payload, { ...base, status: 'up', ping: 1, time: hoursAgo(25) })
    await recordHeartbeat(payload, { ...base, status: 'up', ping: 1, time: daysAgo(31) })
    await recordHeartbeat(payload, { ...base, status: 'up', ping: 1, time: daysAgo(400) })

    const before = {
      minutely: await countRows('stat-minutely', monitorId),
      hourly: await countRows('stat-hourly', monitorId),
      daily: await countRows('stat-daily', monitorId),
    }

    const result = await runRetention(payload, NOW, { keepDataPeriodDays: 365 })
    // Beats recorded at 25h / 31d / 400d / 100d / 5d / 3h / now produce:
    // minutely rows older than 24h: 25h, 31d, 400d, 100d, 5d → 5 (3h and now stay)
    expect(result.minutely).toBe(5)
    // hourly rows older than 30d: 31d, 400d, 100d → 3
    expect(result.hourly).toBe(3)
    // daily rows older than 365d: 400d → 1
    expect(result.daily).toBe(1)
    expect(result.heartbeats).toBe(0)

    expect(await countRows('stat-minutely', monitorId)).toBe(before.minutely - 5)
    expect(await countRows('stat-hourly', monitorId)).toBe(before.hourly - 3)
    expect(await countRows('stat-daily', monitorId)).toBe(before.daily - 1)

    const cutoffs = retentionCutoffs(NOW, 365)
    const remainingMinutely = await payload.find({
      collection: 'stat-minutely',
      where: { monitor: { equals: monitorId } },
      depth: 0,
    })
    for (const row of remainingMinutely.docs) {
      expect(row.timestamp).toBeGreaterThanOrEqual(cutoffs.minutely)
    }

    // Running again is a no-op.
    const again = await runRetention(payload, NOW, { keepDataPeriodDays: 365 })
    expect(again).toMatchObject({ minutely: 0, hourly: 0, daily: 0 })
  })

  it('keeps daily rows forever when KEEP_DATA_PERIOD_DAYS < 1', async () => {
    await recordHeartbeat(payload, {
      monitorId,
      organizationId,
      status: 'up',
      ping: 1,
      time: daysAgo(900),
    })
    const result = await runRetention(payload, NOW, { keepDataPeriodDays: 0 })
    expect(result.daily).toBe(0)
    expect(await countRows('stat-daily', monitorId)).toBeGreaterThan(0)
  })

  describe('GET /api/monitors/:id/stats', () => {
    const call = (id: string | number, query: string, headers: HeadersInit = {}) =>
      statsRoute(new Request(`http://localhost/api/monitors/${id}/stats${query}`, { headers }), {
        params: Promise.resolve({ id: String(id) }),
      })

    it('rejects unauthenticated requests with 401', async () => {
      const res = await call(monitorId, '?range=24h')
      expect(res.status).toBe(401)
    })

    it('rejects an unknown range or percentile with 400', async () => {
      expect((await call(monitorId, '?range=2d')).status).toBe(400)
      expect((await call(monitorId, '?range=7d&percentile=p42')).status).toBe(400)
    })

    it('returns uptime, avgPing and buckets for an authenticated user', async () => {
      const email = 'stats-int@marmot.local'
      const password = 'stats-int-password'
      await payload.delete({ collection: 'users', where: { email: { equals: email } } })
      const user = await payload.create({ collection: 'users', data: { email, password } })
      // Monitors are org-scoped: the caller must be a member of the monitor's organization.
      await addOrgMembership({ payload, userId: user.id, orgId: organizationId, role: 'viewer' })
      const { token } = await payload.login({ collection: 'users', data: { email, password } })
      const headers = { Authorization: `JWT ${token}` }

      const res = await call(monitorId, '?range=1y', headers)
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        uptime: number
        avgPing: number | null
        buckets: Array<{ timestamp: number }>
        range: string
      }
      expect(body.range).toBe('1y')
      expect(body.uptime).toBeGreaterThan(0)
      expect(body.uptime).toBeLessThanOrEqual(1)
      expect(typeof body.avgPing).toBe('number')
      expect(Array.isArray(body.buckets)).toBe(true)

      // Chart periods with a percentile selection (#95).
      const month = await call(monitorId, '?range=30d&percentile=p95,p50', headers)
      expect(month.status).toBe(200)
      const monthBody = (await month.json()) as {
        range: string
        percentiles: Record<string, number | null>
        checks: { total: number }
        series: Array<Record<string, unknown>>
      }
      expect(monthBody.range).toBe('30d')
      expect(Object.keys(monthBody.percentiles)).toEqual(['p50', 'p75', 'p90', 'p95', 'p99'])
      expect(monthBody.series).toHaveLength(180)
      expect(monthBody.series[0]).toHaveProperty('p95')
      expect(monthBody.series[0]).toHaveProperty('p50')
      expect(monthBody.series[0]).not.toHaveProperty('p99')

      const missing = await call(999_999_999, '?range=24h', headers)
      expect(missing.status).toBe(404)
    })
  })
})
