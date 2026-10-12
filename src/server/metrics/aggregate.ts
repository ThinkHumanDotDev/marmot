/**
 * Rollup arithmetic of custom metrics (#155). A bucket keeps count, sum, min, max and the newest
 * value, which is enough to answer every aggregation at read time and to merge buckets into
 * coarser ones. Pure; shared by the push ingestion and the readers.
 */
import type { MetricAggregation } from '@/lib/metrics'

export interface MetricAggregate {
  count: number
  sum: number
  min: number
  max: number
  /** Newest value and its time (unix ms). */
  last: number
  lastAt: number
}

/** The aggregate of a single point. */
export const pointAggregate = (value: number, at: number): MetricAggregate => ({
  count: 1,
  sum: value,
  min: value,
  max: value,
  last: value,
  lastAt: at,
})

/** Merge two aggregates (`a` may be null). */
export function mergeAggregates(a: MetricAggregate | null, b: MetricAggregate): MetricAggregate {
  if (!a) return { ...b }
  const newer = b.lastAt >= a.lastAt ? b : a
  return {
    count: a.count + b.count,
    sum: a.sum + b.sum,
    min: Math.min(a.min, b.min),
    max: Math.max(a.max, b.max),
    last: newer.last,
    lastAt: newer.lastAt,
  }
}

/** The figure an aggregation shows for a bucket or an interval. */
export function aggregateValue(
  aggregate: MetricAggregate | null,
  aggregation: MetricAggregation,
): number | null {
  if (!aggregate || aggregate.count <= 0) return null
  switch (aggregation) {
    case 'sum':
      return aggregate.sum
    case 'last':
      return aggregate.last
    case 'max':
      return aggregate.max
    default:
      return aggregate.sum / aggregate.count
  }
}
