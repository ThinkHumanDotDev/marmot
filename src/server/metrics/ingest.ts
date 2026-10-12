/**
 * Push ingestion of custom metrics (#155): a batch of points is folded into the minutely, hourly
 * and daily `metric-stats` buckets of the metric (same keys and retention as the monitor rollups);
 * raw points are never stored. Pushes of one metric are serialised within the process, and a
 * concurrent insert of the same bucket from another process is retried as an update, like
 * `upsertBucket` in `src/server/stats/uptime-calculator.ts`.
 */
import type { Payload, RequiredDataFromCollectionSlug } from 'payload'

import {
  METRIC_GRANULARITIES,
  METRIC_MAX_POINT_AGE_SECONDS,
  METRIC_MAX_POINT_SKEW_SECONDS,
  type MetricGranularity,
} from '@/lib/metrics'
import type { Metric } from '@/payload-types'
import { relId } from '@/collections/shared'
import { getKey } from '@/server/stats/uptime-calculator'

import { mergeAggregates, pointAggregate, type MetricAggregate } from './aggregate'
import type { MetricPointInput } from './schemas'

export type PointProblem = 'metricPointTooOld' | 'metricPointInFuture'

/** Unix ms of a point (`now` without a timestamp); numbers above 1e11 are taken as milliseconds. */
export function pointTime(point: MetricPointInput, now: Date): number {
  const { timestamp } = point
  if (timestamp === undefined) return now.getTime()
  if (typeof timestamp === 'string') return Date.parse(timestamp)
  return timestamp > 1e11 ? Math.round(timestamp) : Math.round(timestamp * 1000)
}

/** Why a point cannot be accepted, or null. */
export function pointProblem(at: number, now: Date): PointProblem | null {
  if (!Number.isFinite(at) || now.getTime() - at > METRIC_MAX_POINT_AGE_SECONDS * 1000) {
    return 'metricPointTooOld'
  }
  if (at - now.getTime() > METRIC_MAX_POINT_SKEW_SECONDS * 1000) return 'metricPointInFuture'
  return null
}

type StatRow = MetricAggregate & { id: string | number; timestamp: number }

/** Partial aggregates of a batch per granularity and bucket key. Pure; exported for tests. */
export function bucketPoints(
  points: ReadonlyArray<{ value: number; at: number }>,
): Record<MetricGranularity, Map<number, MetricAggregate>> {
  const out = Object.fromEntries(
    METRIC_GRANULARITIES.map((g) => [g, new Map<number, MetricAggregate>()]),
  ) as Record<MetricGranularity, Map<number, MetricAggregate>>
  for (const { value, at } of points) {
    for (const granularity of METRIC_GRANULARITIES) {
      const key = getKey(new Date(at), granularity)
      const buckets = out[granularity]
      buckets.set(key, mergeAggregates(buckets.get(key) ?? null, pointAggregate(value, at)))
    }
  }
  return out
}

const toAggregate = (row: Record<string, unknown>): StatRow => ({
  id: row.id as string | number,
  timestamp: Number(row.timestamp),
  count: Number(row.count ?? 0),
  sum: Number(row.sum ?? 0),
  min: Number(row.min),
  max: Number(row.max),
  last: Number(row.last),
  lastAt: Number(row.lastAt ?? 0),
})

const aggregateData = (a: MetricAggregate) => ({
  count: a.count,
  sum: a.sum,
  min: a.min,
  max: a.max,
  last: a.last,
  lastAt: a.lastAt,
})

async function findRows(
  payload: Payload,
  metricId: string | number,
  granularity: MetricGranularity,
  keys: number[],
): Promise<Map<number, StatRow>> {
  const { docs } = await payload.find({
    collection: 'metric-stats',
    where: {
      and: [
        { metric: { equals: metricId } },
        { granularity: { equals: granularity } },
        { timestamp: { in: keys } },
      ],
    },
    depth: 0,
    limit: keys.length,
    pagination: false,
    overrideAccess: true,
  })
  return new Map(
    docs.map((doc) => {
      const row = toAggregate(doc as unknown as Record<string, unknown>)
      return [row.timestamp, row]
    }),
  )
}

async function upsertGranularity(
  payload: Payload,
  metric: Metric,
  granularity: MetricGranularity,
  buckets: Map<number, MetricAggregate>,
): Promise<void> {
  const keys = [...buckets.keys()]
  const existing = await findRows(payload, metric.id, granularity, keys)
  const organization = relId(metric.organization)
  for (const [timestamp, partial] of buckets) {
    const row = existing.get(timestamp)
    if (row) {
      await payload.update({
        collection: 'metric-stats',
        id: row.id,
        data: aggregateData(mergeAggregates(row, partial)),
        depth: 0,
        overrideAccess: true,
      })
      continue
    }
    try {
      await payload.create({
        collection: 'metric-stats',
        data: {
          metric: metric.id,
          organization,
          granularity,
          timestamp,
          ...aggregateData(partial),
        } as unknown as RequiredDataFromCollectionSlug<'metric-stats'>,
        depth: 0,
        overrideAccess: true,
      })
    } catch (error) {
      // Another process created the bucket first (unique index): merge into it.
      const raced = (await findRows(payload, metric.id, granularity, [timestamp])).get(timestamp)
      if (!raced) throw error
      await payload.update({
        collection: 'metric-stats',
        id: raced.id,
        data: aggregateData(mergeAggregates(raced, partial)),
        depth: 0,
        overrideAccess: true,
      })
    }
  }
}

const queues = new Map<string, Promise<unknown>>()

/** Run `task` after the pushes of the same metric that are still running in this process. */
function serialised<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve()
  const next = previous.then(task, task)
  const settled = next.catch(() => undefined)
  queues.set(key, settled)
  void settled.then(() => {
    if (queues.get(key) === settled) queues.delete(key)
  })
  return next
}

export interface PushResult {
  accepted: number
}

/**
 * Fold validated points (`at` in unix ms) into the metric's rollups and remember its latest value.
 * The caller checks `pointProblem` first.
 */
export async function ingestPoints(
  payload: Payload,
  metric: Metric,
  points: ReadonlyArray<{ value: number; at: number }>,
  now: Date = new Date(),
): Promise<PushResult> {
  if (points.length === 0) return { accepted: 0 }
  await serialised(String(metric.id), async () => {
    const buckets = bucketPoints(points)
    for (const granularity of METRIC_GRANULARITIES) {
      await upsertGranularity(payload, metric, granularity, buckets[granularity])
    }
  })
  const newest = points.reduce((a, b) => (b.at >= a.at ? b : a))
  // Straight through the adapter: bookkeeping, not an audited change.
  await payload.db.updateOne({
    collection: 'metrics',
    id: metric.id,
    data: { lastValue: newest.value, lastPushAt: now.toISOString() },
  })
  return { accepted: points.length }
}
