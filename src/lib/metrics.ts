/**
 * Custom status page metrics (#155): the vocabulary shared by the `metrics` collection, the push
 * and management routes, the public endpoint and the client views. Free of server imports.
 */

/** Where a metric's values come from. */
export const METRIC_SOURCES = ['push', 'monitor'] as const
export type MetricSource = (typeof METRIC_SOURCES)[number]

/** How the values of one chart interval are combined. */
export const METRIC_AGGREGATIONS = ['average', 'sum', 'last', 'max'] as const
export type MetricAggregation = (typeof METRIC_AGGREGATIONS)[number]

/** Periods a visitor can pick; `defaultView` names the one a metric opens with. */
export const METRIC_VIEWS = ['hour', 'day', 'week', 'month'] as const
export type MetricView = (typeof METRIC_VIEWS)[number]
export const DEFAULT_METRIC_VIEW: MetricView = 'day'

export const isMetricView = (value: unknown): value is MetricView =>
  typeof value === 'string' && (METRIC_VIEWS as readonly string[]).includes(value)

/** Rollup granularities a metric is stored in (same buckets and retention as the `stat-*` rows). */
export const METRIC_GRANULARITIES = ['minute', 'hour', 'day'] as const
export type MetricGranularity = (typeof METRIC_GRANULARITIES)[number]

/** Window, backing rollup and interval width of each view. */
export const METRIC_VIEW_SPECS: Record<
  MetricView,
  { seconds: number; granularity: Exclude<MetricGranularity, 'day'>; step: number }
> = {
  hour: { seconds: 3600, granularity: 'minute', step: 60 },
  day: { seconds: 24 * 3600, granularity: 'minute', step: 5 * 60 },
  week: { seconds: 7 * 24 * 3600, granularity: 'hour', step: 3600 },
  month: { seconds: 30 * 24 * 3600, granularity: 'hour', step: 4 * 3600 },
}

export const METRIC_NAME_MAX_LENGTH = 100
export const METRIC_SUFFIX_MAX_LENGTH = 16
export const METRIC_DESCRIPTION_MAX_LENGTH = 500
export const METRIC_MAX_DECIMALS = 6
/** Points accepted by one push request. */
export const METRIC_MAX_POINTS_PER_PUSH = 1000
/** How far back a pushed point may be (the minutely rollup keeps 24 hours). */
export const METRIC_MAX_POINT_AGE_SECONDS = 24 * 3600
/** Clock skew tolerated for points stamped in the future. */
export const METRIC_MAX_POINT_SKEW_SECONDS = 5 * 60
/** Largest magnitude of a pushed value. */
export const METRIC_MAX_ABS_VALUE = 1e15

/** Display thresholds: values at or above `warning`/`critical` are drawn as reference lines. */
export interface MetricThresholds {
  warning: number | null
  critical: number | null
}

/** A metric as the settings UI and the management API show it. */
export interface MetricRow {
  id: string
  name: string
  description: string | null
  suffix: string | null
  decimals: number
  aggregation: MetricAggregation
  defaultView: MetricView
  thresholds: MetricThresholds
  source: MetricSource
  monitor: string | null
  visible: boolean
  order: number
  statusPages: string[]
  lastValue: number | null
  lastPushAt: string | null
  createdAt: string
}

/** One chart interval. */
export interface MetricPoint {
  /** Unix seconds of the interval start. */
  timestamp: number
  /** Aggregated value of the interval, null without data. */
  value: number | null
}

/** A published metric on a status page: display settings and aggregates only. */
export interface PublicMetric {
  /** Opaque id of the metric (used to switch its period). */
  id: string
  name: string
  description?: string
  suffix: string | null
  decimals: number
  aggregation: MetricAggregation
  defaultView: MetricView
  view: MetricView
  thresholds: MetricThresholds
  /** Interval width of `series` in seconds. */
  step: number
  /** Latest value of the period (the last interval with data), null without data. */
  current: number | null
  /** The period's value: the aggregation applied over every interval. */
  summary: number | null
  /** Oldest first; intervals without data have `value: null`. */
  series: MetricPoint[]
}

/** `12.5 ms`, `99.9%`: a unit made of letters is spaced from the number, a symbol is not. */
export const withMetricSuffix = (formatted: string, suffix: string | null | undefined): string => {
  const unit = suffix?.trim()
  if (!unit) return formatted
  return /^\p{L}/u.test(unit) ? `${formatted} ${unit}` : `${formatted}${unit}`
}
