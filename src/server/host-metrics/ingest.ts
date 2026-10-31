/**
 * Host agent ingestion (#136): one sample is folded into the minutely, hourly and daily
 * `host-metrics` rows of its monitor (`[count, sum, min, max, last]` per series); the minutely row
 * also keeps the sample itself for the host summary. Samples of one monitor are serialised within
 * the process, and a concurrent insert of the same bucket from another process is retried as an
 * update, like `src/server/metrics/ingest.ts`.
 */
import type { Payload, RequiredDataFromCollectionSlug, Where } from 'payload'

import { relId } from '@/collections/shared'
import {
  HOST_GRANULARITIES,
  mergeSeries,
  parseSeriesMap,
  sampleSeries,
  type HostGranularity,
  type HostRollupRow,
  type HostSample,
  type HostSeriesMap,
} from '@/lib/host-metrics'
import type { Monitor } from '@/payload-types'
import { getKey } from '@/server/stats/uptime-calculator'

type Id = string | number

interface StoredRow extends HostRollupRow {
  id: Id
  granularity: HostGranularity
  lastAt: number
  latest: unknown
}

const toRow = (doc: Record<string, unknown>): StoredRow => ({
  id: doc.id as Id,
  granularity: doc.granularity as HostGranularity,
  timestamp: Number(doc.timestamp),
  lastAt: Number(doc.lastAt ?? 0),
  series: parseSeriesMap(doc.series),
  latest: doc.latest ?? null,
})

async function findBuckets(
  payload: Payload,
  monitorId: Id,
  keys: { granularity: HostGranularity; timestamp: number }[],
): Promise<StoredRow[]> {
  const where: Where = {
    and: [
      { monitor: { equals: monitorId } },
      {
        or: keys.map(({ granularity, timestamp }): Where => ({
          and: [
            { granularity: { equals: granularity } } as Where,
            { timestamp: { equals: timestamp } } as Where,
          ],
        })),
      },
    ],
  }
  const { docs } = await payload.find({
    collection: 'host-metrics',
    where,
    depth: 0,
    limit: keys.length,
    pagination: false,
    overrideAccess: true,
  })
  return docs.map((doc) => toRow(doc as unknown as Record<string, unknown>))
}

const queues = new Map<string, Promise<unknown>>()

/** Run `task` after the samples of the same monitor that are still being written in this process. */
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

/** Fold one sample, received at `now`, into the monitor's rollups. Returns the series written. */
export async function ingestHostSample(
  payload: Payload,
  monitor: Monitor,
  sample: HostSample,
  now: Date = new Date(),
): Promise<Record<string, number>> {
  const values = sampleSeries(sample)
  const at = now.getTime()
  const organization = relId(monitor.organization)
  const keys = HOST_GRANULARITIES.map((granularity) => ({
    granularity,
    timestamp: getKey(now, granularity),
  }))

  await serialised(String(monitor.id), async () => {
    const existing = await findBuckets(payload, monitor.id, keys)
    for (const { granularity, timestamp } of keys) {
      const latest = granularity === 'minute' ? { ...sample, receivedAt: now.toISOString() } : null
      const data = (series: HostSeriesMap, lastAt: number) => ({
        series: mergeSeries(series, values),
        lastAt: Math.max(lastAt, at),
        ...(latest ? { latest } : {}),
      })
      const row = existing.find((r) => r.granularity === granularity && r.timestamp === timestamp)
      if (row) {
        await payload.update({
          collection: 'host-metrics',
          id: row.id,
          data: data(row.series, row.lastAt),
          depth: 0,
          overrideAccess: true,
        })
        continue
      }
      try {
        await payload.create({
          collection: 'host-metrics',
          data: {
            monitor: monitor.id,
            organization,
            granularity,
            timestamp,
            ...data({}, 0),
          } as unknown as RequiredDataFromCollectionSlug<'host-metrics'>,
          depth: 0,
          overrideAccess: true,
        })
      } catch (error) {
        // Another process created the bucket first (unique index): merge into it.
        const raced = (await findBuckets(payload, monitor.id, [{ granularity, timestamp }]))[0]
        if (!raced) throw error
        await payload.update({
          collection: 'host-metrics',
          id: raced.id,
          data: data(raced.series, raced.lastAt),
          depth: 0,
          overrideAccess: true,
        })
      }
    }
  })
  return values
}

/** The newest minutely rows of a monitor (newest first), at most `limit`, from `since` (unix s). */
export async function recentHostRows(
  payload: Payload,
  monitorId: Id,
  since: number,
  limit: number,
): Promise<StoredRow[]> {
  const { docs } = await payload.find({
    collection: 'host-metrics',
    where: {
      and: [
        { monitor: { equals: monitorId } },
        { granularity: { equals: 'minute' } },
        { timestamp: { greater_than_equal: since } },
      ],
    },
    sort: '-timestamp',
    depth: 0,
    limit,
    pagination: false,
    overrideAccess: true,
  })
  return docs.map((doc) => toRow(doc as unknown as Record<string, unknown>))
}

/** The newest minutely row of a monitor, whatever its age, or `null`. */
export async function newestHostRow(payload: Payload, monitorId: Id): Promise<StoredRow | null> {
  const rows = await recentHostRows(payload, monitorId, 0, 1)
  return rows[0] ?? null
}
