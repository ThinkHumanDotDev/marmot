/**
 * Synthetic history for the demo dataset (#159): heartbeats and the stat roll-ups the charts read,
 * so the 90-day bars, the uptime figures, the percentile chart (#95), the timing breakdown (#94)
 * and the location table (#92) are populated right after a reset.
 *
 * Samples come from `simulateOutcome` (the function live demo checks use) and are folded with the
 * engine's own `applyBeat`, so the rows look exactly like rows the worker writes. They are inserted
 * through the database adapter (`payload.db.create`): the collections are worker-written telemetry
 * without hooks, and per-row Local API calls would make a reset take minutes.
 *
 * Volume per monitor: minutely rows for the last day (every five minutes, at the monitor's interval
 * in the last two hours), 30 days of hourly rows, 90 days of daily rows, the last 100 heartbeats
 * plus the status changes of the last day. Older samples are taken every ten minutes, which is
 * invisible at the hourly and daily granularity of those charts.
 */
import type { Payload } from 'payload'

import { degradedThresholdMs } from '@/lib/monitor-degraded'
import {
  applyBeat,
  emptyBucket,
  getDailyKey,
  getHourlyKey,
  getMinutelyKey,
  type BucketData,
  type HeartbeatStatus,
} from '@/server/stats/uptime-calculator'

import type { DemoProfile } from './dataset'
import { simulateOutcome, type SimulatedOutcome } from './simulate'

type Id = string | number

export interface HistoryMonitor {
  id: Id
  key: string
  type: string
  url?: string | null
  interval: number
  degradedAfter?: number | null
  profile: DemoProfile
  /** Location keys (`local` or a location id) with the slug the simulator uses for latency. */
  locations: readonly { key: string; slug: string | null }[]
  /** No samples after this instant (paused monitors). */
  until?: Date | null
  /** Beats during these windows are MAINTENANCE. */
  maintenance?: readonly { from: Date; to: Date }[]
}

export interface HistoryOptions {
  now: Date
  /** Days of daily rows (default 90). Tests pass less. */
  days?: number
  /** Parallel inserts (default 10, the Postgres pool size). */
  concurrency?: number
}

export interface HistoryCounts {
  heartbeats: number
  minutely: number
  hourly: number
  daily: number
  locationHourly: number
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
/** Sampling step for history older than a day. */
const COARSE_STEP = 10 * MINUTE
/** Sampling step for the last day before the final two hours (the 24 h chart folds 5 minutes). */
const MEDIUM_STEP = 5 * MINUTE
/** The last two hours are sampled at the monitor's interval (heartbeat list, 1 h views). */
const FINE_SPAN = 2 * HOUR
const RECENT_HEARTBEATS = 100

/** Run `tasks` with at most `limit` in flight. */
async function inPool(tasks: (() => Promise<unknown>)[], limit: number): Promise<void> {
  let next = 0
  const run = async () => {
    while (next < tasks.length) {
      const task = tasks[next++]
      await task()
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, run))
}

const statusOf = (
  outcome: SimulatedOutcome,
  monitor: HistoryMonitor,
  time: Date,
): HeartbeatStatus => {
  if (monitor.maintenance?.some((w) => time >= w.from && time < w.to)) return 'maintenance'
  if (!outcome.ok) return 'down'
  const threshold = degradedThresholdMs({
    type: monitor.type,
    degradedAfter: monitor.degradedAfter,
  })
  return threshold !== null && outcome.ping !== null && outcome.ping > threshold ? 'degraded' : 'up'
}

const bucketRow = (bucket: BucketData) => ({
  up: bucket.up,
  down: bucket.down,
  ping: bucket.ping,
  pingMin: bucket.pingMin,
  pingMax: bucket.pingMax,
  extras: Object.keys(bucket.extras).length > 0 ? bucket.extras : null,
})

type Sample = { time: Date; outcome: SimulatedOutcome; status: HeartbeatStatus }

/**
 * The samples of one location of `monitor`, oldest first: every ten minutes before `recentFrom`,
 * every five minutes in the last day and at the monitor's interval in the last two hours.
 */
function samplesFor(
  monitor: HistoryMonitor,
  slug: string | null,
  from: number,
  to: number,
  recentFrom: number,
): Sample[] {
  const step = Math.max(monitor.interval, 60) * 1000
  const coarse = Math.max(COARSE_STEP, step)
  const medium = Math.max(MEDIUM_STEP, step)
  const fineFrom = Math.max(recentFrom, to - FINE_SPAN)
  const samples: Sample[] = []
  const sample = (t: number) => {
    const time = new Date(t)
    const outcome = simulateOutcome({
      key: monitor.key,
      type: monitor.type,
      profile: monitor.profile,
      time,
      location: slug,
      secure: !monitor.url || /^(https|wss):/i.test(monitor.url),
    })
    samples.push({ time, outcome, status: statusOf(outcome, monitor, time) })
  }
  // Aligned on the step, so the live beats that follow continue the series without a gap.
  for (let t = Math.ceil(from / coarse) * coarse; t < Math.min(recentFrom, to); t += coarse)
    sample(t)
  const mediumTo = Math.min(fineFrom, to)
  for (let t = Math.ceil(Math.max(from, recentFrom) / medium) * medium; t < mediumTo; t += medium) {
    sample(t)
  }
  for (let t = Math.ceil(Math.max(from, fineFrom) / step) * step; t <= to; t += step) sample(t)
  return samples
}

/**
 * Write the history of `monitor` in `organization` and return the row counts plus the most recent
 * sample (the seed copies it into the monitor's `status`).
 */
export async function writeMonitorHistory(
  payload: Payload,
  organization: Id,
  monitor: HistoryMonitor,
  { now, days = 90, concurrency = 10 }: HistoryOptions,
): Promise<{ counts: HistoryCounts; last: Sample | null }> {
  const end = Math.min(now.getTime(), monitor.until?.getTime() ?? Infinity) - 1000
  const start = now.getTime() - days * DAY
  const recentFrom = now.getTime() - DAY
  const hourlyFrom = now.getTime() - 30 * DAY
  const counts: HistoryCounts = {
    heartbeats: 0,
    minutely: 0,
    hourly: 0,
    daily: 0,
    locationHourly: 0,
  }
  if (end <= start) return { counts, last: null }

  const primary = monitor.locations[0]
  const tasks: (() => Promise<unknown>)[] = []
  const create = (collection: Parameters<Payload['db']['create']>[0]['collection'], data: object) =>
    tasks.push(() => payload.db.create({ collection, data: data as Record<string, unknown> }))

  // The monitor's own series follows its primary location (the local workers when they check it).
  const main = samplesFor(monitor, primary?.slug ?? null, start, end, recentFrom)
  const minutely = new Map<number, BucketData>()
  const hourly = new Map<number, BucketData>()
  const daily = new Map<number, BucketData>()
  const fold = (map: Map<number, BucketData>, key: number, sample: Sample) =>
    map.set(
      key,
      applyBeat(
        map.get(key) ?? emptyBucket(),
        sample.status,
        sample.outcome.ping,
        sample.outcome.timing,
      ),
    )
  for (const sample of main) {
    const t = sample.time.getTime()
    fold(daily, getDailyKey(sample.time), sample)
    if (t >= hourlyFrom) fold(hourly, getHourlyKey(sample.time), sample)
    if (t >= recentFrom) fold(minutely, getMinutelyKey(sample.time), sample)
  }
  const statRows = (
    collection: 'stat-minutely' | 'stat-hourly' | 'stat-daily',
    map: Map<number, BucketData>,
  ) => {
    for (const [timestamp, bucket] of map) {
      create(collection, {
        monitor: monitor.id,
        organization,
        timestamp,
        ...bucketRow(bucket),
        latencyHistogram: bucket.latencyHistogram ?? null,
      })
    }
    return map.size
  }
  counts.minutely = statRows('stat-minutely', minutely)
  counts.hourly = statRows('stat-hourly', hourly)
  counts.daily = statRows('stat-daily', daily)

  // Per-location series of multi-location monitors (#92): 30 days of hourly rows per location.
  if (monitor.locations.length > 1) {
    for (const location of monitor.locations) {
      const series =
        location === primary
          ? main.filter((s) => s.time.getTime() >= hourlyFrom)
          : samplesFor(monitor, location.slug, hourlyFrom, end, recentFrom)
      const buckets = new Map<number, BucketData>()
      for (const sample of series) fold(buckets, getHourlyKey(sample.time), sample)
      for (const [timestamp, bucket] of buckets) {
        create('stat-location-hourly', {
          monitor: monitor.id,
          organization,
          location: location.key,
          timestamp,
          ...bucketRow(bucket),
        })
      }
      counts.locationHourly += buckets.size
    }
  }

  // Heartbeats: the last 100 beats and every status change of the last day (the "important" list).
  const recent = main.filter((s) => s.time.getTime() >= recentFrom)
  const tail = new Set(recent.slice(-RECENT_HEARTBEATS))
  let previous: HeartbeatStatus | null = null
  for (const sample of recent) {
    const important = previous !== null && sample.status !== previous
    previous = sample.status
    if (!important && !tail.has(sample)) continue
    create('heartbeats', {
      monitor: monitor.id,
      organization,
      status: sample.status,
      msg: sample.status === 'maintenance' ? 'Monitor under maintenance' : sample.outcome.msg,
      ping:
        sample.status === 'down' || sample.status === 'maintenance' ? null : sample.outcome.ping,
      important,
      timing: sample.status === 'up' || sample.status === 'degraded' ? sample.outcome.timing : null,
      statusCode: sample.outcome.statusCode,
      retries: 0,
      downCount: 0,
      time: sample.time.toISOString(),
    })
    counts.heartbeats += 1
  }
  await inPool(tasks, concurrency)
  return { counts, last: main.at(-1) ?? null }
}
