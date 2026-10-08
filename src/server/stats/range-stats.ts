/**
 * Chart statistics for a monitor (#95): latency percentiles, check counts and a time series of
 * fixed intervals, all derived from the stat rollups (never from raw heartbeats).
 *
 * `getRangeStats()` reads the buckets of a range through `getStats()` (which picks the rollup:
 * minutely for 1d, hourly for 7d/14d/30d, daily for 90d/1y), merges their latency histograms for
 * the window's percentiles and folds them into `CHART_STEP_SECONDS[range]` intervals for the chart.
 */
import type { Payload } from 'payload'

import { mergeBucketTiming, type RequestTiming } from '@/lib/request-timing'

import {
  estimatePercentiles,
  mergeHistograms,
  PERCENTILES,
  type Percentile,
  type PercentileValues,
} from './latency-histogram'
import {
  getStats,
  pingWeight,
  rangeWindow,
  type Bucket,
  type MonitorId,
  type MonitorStats,
  type ReadOptions,
  type StatsRange,
} from './uptime-calculator'

/** The periods offered by the monitor detail page. */
export const CHART_RANGES = [
  '1d',
  '7d',
  '14d',
  '30d',
  '90d',
] as const satisfies readonly StatsRange[]
export type ChartRange = (typeof CHART_RANGES)[number]

export const isChartRange = (value: unknown): value is ChartRange =>
  typeof value === 'string' && (CHART_RANGES as readonly string[]).includes(value)

/** Width of one chart interval per range (a multiple of the backing rollup's bucket). */
export const CHART_STEP_SECONDS: Record<StatsRange, number> = {
  '24h': 5 * 60,
  '1d': 5 * 60,
  '7d': 60 * 60,
  '14d': 2 * 60 * 60,
  '30d': 4 * 60 * 60,
  '90d': 24 * 60 * 60,
  '1y': 24 * 60 * 60,
}

export type CheckCounts = {
  /** All recorded checks (up + down). */
  total: number
  up: number
  /** Down and pending checks. */
  failed: number
  /** Slow successful checks (also counted in `up`). */
  degraded: number
  /** Checks during maintenance (also counted in `up`). */
  maintenance: number
}

export type SeriesPoint = {
  /** Unix seconds of the interval start. */
  timestamp: number
  up: number
  down: number
  degraded: number
  maintenance: number
  /** Average ping of the interval, null without pinged beats. */
  ping: number | null
  pingMin: number | null
  pingMax: number | null
  /** Average request timing phases of the interval (#94); only on intervals that measured them. */
  timing?: RequestTiming
} & Partial<PercentileValues>

export type RangeStats = Omit<MonitorStats, 'buckets'> & {
  /** Raw rollup rows of the window, without their histograms (kept for API compatibility). */
  buckets: Array<Omit<Bucket, 'latencyHistogram'>>
  /** Percentiles over the whole window (all five). */
  percentiles: PercentileValues
  checks: CheckCounts
  /** Interval width of `series` in seconds. */
  step: number
  /** One point per interval of the window, oldest first; empty intervals have zero counts. */
  series: SeriesPoint[]
}

const countOf = (value: unknown): number => (typeof value === 'number' ? value : 0)

const minOf = (values: Array<number | null>): number | null => {
  const numbers = values.filter((v): v is number => v !== null)
  return numbers.length > 0 ? Math.min(...numbers) : null
}

const maxOf = (values: Array<number | null>): number | null => {
  const numbers = values.filter((v): v is number => v !== null)
  return numbers.length > 0 ? Math.max(...numbers) : null
}

/** Percentiles of a set of buckets: merge the histograms, bound by the exact min/max. */
export function bucketPercentiles(
  buckets: readonly Bucket[],
  percentiles: readonly Percentile[] = PERCENTILES,
): Partial<PercentileValues> {
  const histogram = mergeHistograms(buckets.map((b) => b.latencyHistogram))
  return estimatePercentiles(
    histogram,
    { min: minOf(buckets.map((b) => b.pingMin)), max: maxOf(buckets.map((b) => b.pingMax)) },
    percentiles,
  )
}

export function countChecks(buckets: readonly Bucket[]): CheckCounts {
  const counts: CheckCounts = { total: 0, up: 0, failed: 0, degraded: 0, maintenance: 0 }
  for (const bucket of buckets) {
    counts.up += bucket.up
    counts.failed += bucket.down
    counts.degraded += countOf(bucket.extras?.degraded)
    counts.maintenance += countOf(bucket.extras?.maintenance)
  }
  counts.total = counts.up + counts.failed
  return counts
}

/**
 * Fold buckets into consecutive `step`-second intervals covering `[from, to]` (bucket keys). The
 * intervals are aligned to `step` and end with the one holding `to`; their number is fixed by the
 * window's length (e.g. 180 for 30 days in 4-hour steps), so a bucket of a window that does not
 * start on a step boundary joins the first interval. Pure; exported for tests.
 */
export function buildSeries(
  buckets: readonly Bucket[],
  window: { from: number; to: number },
  step: number,
  percentiles: readonly Percentile[] = PERCENTILES,
): SeriesPoint[] {
  const last = Math.floor(window.to / step) * step
  const count = Math.max(1, Math.ceil((window.to - window.from + 1) / step))
  const first = last - (count - 1) * step

  const groups = new Map<number, Bucket[]>()
  for (const bucket of buckets) {
    const key = Math.max(first, Math.floor(bucket.timestamp / step) * step)
    const group = groups.get(key)
    if (group) group.push(bucket)
    else groups.set(key, [bucket])
  }

  const series: SeriesPoint[] = []
  for (let timestamp = first; timestamp <= last; timestamp += step) {
    const group = groups.get(timestamp) ?? []
    const counts = countChecks(group)
    const timing = mergeBucketTiming(group.map((bucket) => bucket.extras))
    let pingTotal = 0
    let weightTotal = 0
    for (const bucket of group) {
      if (bucket.ping === null) continue
      const weight = pingWeight(bucket)
      pingTotal += bucket.ping * weight
      weightTotal += weight
    }
    series.push({
      timestamp,
      up: counts.up,
      down: counts.failed,
      degraded: counts.degraded,
      maintenance: counts.maintenance,
      ping: weightTotal > 0 ? pingTotal / weightTotal : null,
      pingMin: minOf(group.map((b) => b.pingMin)),
      pingMax: maxOf(group.map((b) => b.pingMax)),
      ...(percentiles.length > 0 ? bucketPercentiles(group, percentiles) : {}),
      ...(timing ? { timing } : {}),
    })
  }
  return series
}

export type RangeStatsOptions = ReadOptions & {
  /** Percentiles to include in each series point (default: all five). */
  percentiles?: readonly Percentile[]
}

/** Uptime, average ping, percentiles, check counts and the chart series of a monitor over `range`. */
export async function getRangeStats(
  payload: Payload,
  monitorId: MonitorId,
  range: StatsRange,
  options: RangeStatsOptions = {},
): Promise<RangeStats> {
  const now = options.now ?? new Date()
  const stats = await getStats(payload, monitorId, range, { now })
  const step = CHART_STEP_SECONDS[range]
  return {
    ...stats,
    buckets: stats.buckets.map(({ latencyHistogram: _histogram, ...bucket }) => bucket),
    percentiles: bucketPercentiles(stats.buckets) as PercentileValues,
    checks: countChecks(stats.buckets),
    step,
    series: buildSeries(
      stats.buckets,
      rangeWindow(range, now),
      step,
      options.percentiles ?? PERCENTILES,
    ),
  }
}
