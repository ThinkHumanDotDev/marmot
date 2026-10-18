/**
 * Push ingestion of custom metrics (#155): a batch of points is folded into the minutely, hourly
 * and daily `metric-stats` buckets of the metric (same keys and retention as the monitor rollups);
 * raw points are never stored. Points older than the minutely rollup's 24 hours are backfilled
 * into the rollups that still keep their time (#280): hourly up to 30 days, daily up to the data
 * period. Pushes of one metric are serialised within the process and across processes by a Redis
 * lock (`./lock.ts`), and a concurrent insert of the same bucket is retried as an update, like
 * `upsertBucket` in `src/server/stats/uptime-calculator.ts`.
 */
import type { Payload, RequiredDataFromCollectionSlug } from 'payload'

import {
  METRIC_GRANULARITIES,
  METRIC_HOURLY_MAX_AGE_SECONDS,
  METRIC_MAX_BACKFILL_DAYS,
  METRIC_MAX_POINT_AGE_SECONDS,
  METRIC_MAX_POINT_SKEW_SECONDS,
  type MetricGranularity,
} from '@/lib/metrics'
import type { Metric } from '@/payload-types'
import { relId } from '@/collections/shared'
import { getKey } from '@/server/stats/uptime-calculator'

import { mergeAggregates, pointAggregate, type MetricAggregate } from './aggregate'
import { withMetricLock } from './lock'
import type { MetricPointInput } from './schemas'

export type PointProblem = 'metricPointTooOld' | 'metricPointInFuture'

/** Unix ms of a point (`now` without a timestamp); numbers above 1e11 are taken as milliseconds. */
export function pointTime(point: MetricPointInput, now: Date): number {
  const { timestamp } = point
  if (timestamp === undefined) return now.getTime()
  if (typeof timestamp === 'string') return Date.parse(timestamp)
  return timestamp > 1e11 ? Math.round(timestamp) : Math.round(timestamp * 1000)
}

/**
 * Oldest age (seconds) a point may have: the daily rollup's retention (`keepDataPeriodDays`), or
 * `METRIC_MAX_BACKFILL_DAYS` when long-term retention is off (below 1 day).
 */
export const maxPointAgeSeconds = (keepDataPeriodDays: number): number =>
  Math.max(
    METRIC_MAX_POINT_AGE_SECONDS,
    (keepDataPeriodDays >= 1 ? keepDataPeriodDays : METRIC_MAX_BACKFILL_DAYS) * 86400,
  )

/** Why a point cannot be accepted, or null. `maxAgeSeconds` from `maxPointAgeSeconds`. */
export function pointProblem(
  at: number,
  now: Date,
  maxAgeSeconds: number = METRIC_MAX_POINT_AGE_SECONDS,
): PointProblem | null {
  if (!Number.isFinite(at) || now.getTime() - at > maxAgeSeconds * 1000) {
    return 'metricPointTooOld'
  }
  if (at - now.getTime() > METRIC_MAX_POINT_SKEW_SECONDS * 1000) return 'metricPointInFuture'
  return null
}

/**
 * The rollups a point at `at` goes into: those whose retention still keeps its time (minutely 24
 * hours, hourly 30 days, daily always; the caller bounds the age with `pointProblem`).
 */
export function granularitiesFor(at: number, now: Date): MetricGranularity[] {
  const age = now.getTime() - at
  return METRIC_GRANULARITIES.filter((granularity) => {
    if (granularity === 'minute') return age <= METRIC_MAX_POINT_AGE_SECONDS * 1000
    if (granularity === 'hour') return age <= METRIC_HOURLY_MAX_AGE_SECONDS * 1000
    return true
  })
}

type StatRow = MetricAggregate & { id: string | number; timestamp: number }

/**
 * Partial aggregates of a batch per granularity and bucket key; old points only reach the rollups
 * that keep their time (`granularitiesFor`). Pure; exported for tests.
 */
export function bucketPoints(
  points: ReadonlyArray<{ value: number; at: number }>,
  now: Date = new Date(),
): Record<MetricGranularity, Map<number, MetricAggregate>> {
  const out = Object.fromEntries(
    METRIC_GRANULARITIES.map((g) => [g, new Map<number, MetricAggregate>()]),
  ) as Record<MetricGranularity, Map<number, MetricAggregate>>
  for (const { value, at } of points) {
    for (const granularity of granularitiesFor(at, now)) {
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
  if (keys.length === 0) return
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

export interface PushResult {
  accepted: number
}

/**
 * Fold validated points (`at` in unix ms) into the metric's rollups and remember its latest value.
 * The caller checks `pointProblem` first. A batch of backfilled points only (all older than 24
 * hours) leaves a known latest value alone.
 */
export async function ingestPoints(
  payload: Payload,
  metric: Metric,
  points: ReadonlyArray<{ value: number; at: number }>,
  now: Date = new Date(),
): Promise<PushResult> {
  if (points.length === 0) return { accepted: 0 }
  await withMetricLock(String(metric.id), async () => {
    const buckets = bucketPoints(points, now)
    for (const granularity of METRIC_GRANULARITIES) {
      await upsertGranularity(payload, metric, granularity, buckets[granularity])
    }
  })
  const newest = points.reduce((a, b) => (b.at >= a.at ? b : a))
  const recent =
    now.getTime() - newest.at <= METRIC_MAX_POINT_AGE_SECONDS * 1000 ||
    metric.lastValue === null ||
    metric.lastValue === undefined
  // Straight through the adapter: bookkeeping, not an audited change.
  await payload.db.updateOne({
    collection: 'metrics',
    id: metric.id,
    data: {
      ...(recent ? { lastValue: newest.value } : {}),
      lastPushAt: now.toISOString(),
    },
  })
  return { accepted: points.length }
}
