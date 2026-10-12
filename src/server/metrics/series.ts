/**
 * Chart series of custom metrics (#155): the rollups of a view's window folded into fixed
 * intervals. Pushed metrics read `metric-stats`; monitor-backed metrics read the value their
 * monitor records in its own `stat-*` rollups (`extras.value`, Prometheus query monitors), so
 * neither keeps raw points.
 */
import type { Payload } from 'payload'

import { relId } from '@/collections/shared'
import {
  METRIC_VIEW_SPECS,
  type MetricAggregation,
  type MetricPoint,
  type MetricView,
} from '@/lib/metrics'
import type { Metric } from '@/payload-types'
import { COLLECTION_BY_GRANULARITY, type BucketExtras } from '@/server/stats/uptime-calculator'

import { aggregateValue, mergeAggregates, type MetricAggregate } from './aggregate'

export interface MetricSeries {
  view: MetricView
  step: number
  series: MetricPoint[]
  current: number | null
  summary: number | null
}

type Row = MetricAggregate & { timestamp: number }

/** `[from, to)` unix seconds of a view ending with the interval that holds `now`. */
export function viewWindow(
  view: MetricView,
  now: Date,
): { from: number; to: number; step: number } {
  const { seconds, step } = METRIC_VIEW_SPECS[view]
  const to = (Math.floor(now.getTime() / 1000 / step) + 1) * step
  return { from: to - seconds, to, step }
}

/** Fold rollup rows into the view's intervals. Pure; exported for tests. */
export function foldSeries(
  rows: readonly Row[],
  aggregation: MetricAggregation,
  window: { from: number; to: number; step: number },
): Omit<MetricSeries, 'view'> {
  const count = Math.round((window.to - window.from) / window.step)
  const intervals: Array<MetricAggregate | null> = Array.from({ length: count }, () => null)
  let total: MetricAggregate | null = null
  for (const row of rows) {
    const index = Math.floor((row.timestamp - window.from) / window.step)
    if (index < 0 || index >= count) continue
    intervals[index] = mergeAggregates(intervals[index], row)
    total = mergeAggregates(total, row)
  }
  const series = intervals.map((aggregate, i) => ({
    timestamp: window.from + i * window.step,
    value: aggregateValue(aggregate, aggregation),
  }))
  const latest = [...intervals].reverse().find((aggregate) => aggregate !== null) ?? null
  return {
    step: window.step,
    series,
    current: aggregateValue(latest, aggregation),
    summary: aggregateValue(total, aggregation),
  }
}

async function pushedRows(
  payload: Payload,
  metric: Metric,
  view: MetricView,
  window: { from: number; to: number },
): Promise<Row[]> {
  const { docs } = await payload.find({
    collection: 'metric-stats',
    where: {
      and: [
        { metric: { equals: metric.id } },
        { granularity: { equals: METRIC_VIEW_SPECS[view].granularity } },
        { timestamp: { greater_than_equal: window.from } },
        { timestamp: { less_than: window.to } },
      ],
    },
    sort: 'timestamp',
    depth: 0,
    limit: 0,
    pagination: false,
    overrideAccess: true,
  })
  return docs.map((doc) => ({
    timestamp: doc.timestamp,
    count: doc.count,
    sum: doc.sum,
    min: doc.min,
    max: doc.max,
    last: doc.last,
    lastAt: doc.lastAt,
  }))
}

async function monitorRows(
  payload: Payload,
  metric: Metric,
  view: MetricView,
  window: { from: number; to: number },
): Promise<Row[]> {
  const monitor = relId(metric.monitor)
  if (monitor === null) return []
  const { docs } = await payload.find({
    collection: COLLECTION_BY_GRANULARITY[METRIC_VIEW_SPECS[view].granularity],
    where: {
      and: [
        { monitor: { equals: monitor } },
        // A monitor moved to another organization no longer feeds the metric.
        { organization: { equals: relId(metric.organization) } },
        { timestamp: { greater_than_equal: window.from } },
        { timestamp: { less_than: window.to } },
      ],
    },
    sort: 'timestamp',
    depth: 0,
    limit: 0,
    pagination: false,
    overrideAccess: true,
    select: { timestamp: true, extras: true },
  })
  return docs.flatMap((doc): Row[] => {
    const value = (doc.extras as BucketExtras | null | undefined)?.value
    if (!value || !(value.count > 0)) return []
    return [
      {
        timestamp: doc.timestamp,
        count: value.count,
        sum: value.avg * value.count,
        min: value.min,
        max: value.max,
        // The rollup keeps no latest value; the bucket average stands in for it.
        last: value.avg,
        lastAt: doc.timestamp * 1000,
      },
    ]
  })
}

/** The metric's chart over `view`. */
export async function readMetricSeries(
  payload: Payload,
  metric: Metric,
  view: MetricView,
  now: Date = new Date(),
): Promise<MetricSeries> {
  const window = viewWindow(view, now)
  const rows =
    metric.source === 'monitor'
      ? await monitorRows(payload, metric, view, window)
      : await pushedRows(payload, metric, view, window)
  return { view, ...foldSeries(rows, metric.aggregation ?? 'average', window) }
}
