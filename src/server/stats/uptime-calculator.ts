/**
 * Uptime calculator: per-monitor time-series aggregation.
 *
 * Ported to TypeScript from Uptime Kuma 2.x `server/uptime-calculator.js`
 * (MIT License, Copyright (c) 2021 Louis Lam, https://github.com/louislam/uptime-kuma).
 * See THIRD_PARTY_NOTICES.md.
 *
 * Differences from the original:
 * - Buckets live only in the database (`stat-minutely` / `stat-hourly` / `stat-daily`) and are
 *   upserted with read-modify-write through the Payload Local API; there is no in-process cache,
 *   so several worker processes may record beats concurrently.
 * - `maintenance` beats count as `up` (they never lower uptime) and are additionally counted in
 *   `extras.maintenance`; `pending` beats count as `down`.
 * - `degraded` beats (#93, a slow success) count as `up`, are counted in `extras.degraded` and
 *   their response time feeds the ping statistics like any other successful check.
 * - The running ping average is weighted by the number of beats that actually carried a ping
 *   (`extras.pingCount`) rather than by `up`, which keeps it exact when pings are missing.
 * - Retention is a separate hourly job (`src/server/jobs/retention.ts`), not part of `update`.
 */
import type { Payload, RequiredDataFromCollectionSlug, Where } from 'payload'

import type { StatCollectionSlug } from '@/collections/StatFields'
import { childLogger } from '@/lib/logger'
import { applyTiming, parseRequestTiming, type BucketTiming } from '@/lib/request-timing'

import { addSample, parseHistogram, type LatencyHistogram } from './latency-histogram'

const log = childLogger('stats')

export type HeartbeatStatus = 'up' | 'down' | 'pending' | 'maintenance' | 'degraded'
export type FlatStatus = 'up' | 'down'
export type Granularity = 'minute' | 'hour' | 'day'
/**
 * `24h`, `30d` and `1y` are the original windows (uptime cards, badges, metrics); `1d` … `90d` are
 * the chart periods of the monitor detail page (#95). `24h` and `1d` cover the same window.
 */
export type StatsRange = '24h' | '1d' | '7d' | '14d' | '30d' | '90d' | '1y'

export const STATS_RANGES: readonly StatsRange[] = ['24h', '1d', '7d', '14d', '30d', '90d', '1y']

export const isStatsRange = (value: unknown): value is StatsRange =>
  typeof value === 'string' && (STATS_RANGES as readonly string[]).includes(value)

/** Bucket width in seconds per granularity. */
export const BUCKET_SECONDS: Record<Granularity, number> = {
  minute: 60,
  hour: 3600,
  day: 86400,
}

export type RangeSpec = {
  granularity: Granularity
  /** Number of buckets covered by the range (1440 minutes, 720 hours, 365 days). */
  buckets: number
  collection: StatCollectionSlug
}

/**
 * Which aggregate backs which range: the finest one whose retention still covers the window —
 * minutely up to a day, hourly up to 30 days (its retention), daily beyond.
 */
export const RANGE_SPECS: Record<StatsRange, RangeSpec> = {
  '24h': { granularity: 'minute', buckets: 24 * 60, collection: 'stat-minutely' },
  '1d': { granularity: 'minute', buckets: 24 * 60, collection: 'stat-minutely' },
  '7d': { granularity: 'hour', buckets: 7 * 24, collection: 'stat-hourly' },
  '14d': { granularity: 'hour', buckets: 14 * 24, collection: 'stat-hourly' },
  '30d': { granularity: 'hour', buckets: 30 * 24, collection: 'stat-hourly' },
  '90d': { granularity: 'day', buckets: 90, collection: 'stat-daily' },
  '1y': { granularity: 'day', buckets: 365, collection: 'stat-daily' },
}

export const GRANULARITIES: readonly Granularity[] = ['minute', 'hour', 'day']

export const COLLECTION_BY_GRANULARITY: Record<Granularity, StatCollectionSlug> = {
  minute: 'stat-minutely',
  hour: 'stat-hourly',
  day: 'stat-daily',
}

/** In-memory shape of a bucket (what is stored in a `stat-*` row). */
export type BucketData = {
  up: number
  down: number
  /** Average ping of UP and DEGRADED beats, null until the first beat with a ping. */
  ping: number | null
  pingMin: number | null
  pingMax: number | null
  extras: BucketExtras
  /** Response-time histogram of the pinged beats (`latency-histogram.ts`); null before the first. */
  latencyHistogram?: LatencyHistogram | null
}

export type BucketExtras = {
  /** Number of maintenance beats (also counted in `up`). */
  maintenance?: number
  /** Number of degraded beats (also counted in `up`). */
  degraded?: number
  /** Number of UP beats that carried a ping; weight of `ping` in the running average. */
  pingCount?: number
  /** Per-phase running averages of the request timing (#94), `{ dns: { avg, count }, … }`. */
  timing?: BucketTiming
  [key: string]: unknown
}

export type Bucket = BucketData & { timestamp: number }

export type UptimeDataResult = {
  /** 0..1 — fraction of UP beats over UP + DOWN beats (0 when there is no data). */
  uptime: number
  /** Average ping in ms, null when no UP beat carried a ping. */
  avgPing: number | null
  /** Degraded checks in the summed buckets (included in the uptime as up). */
  degraded: number
}

export type MonitorStats = UptimeDataResult & {
  range: StatsRange
  granularity: Granularity
  buckets: Bucket[]
}

// ---------------------------------------------------------------------------------------------
// Pure maths
// ---------------------------------------------------------------------------------------------

const toUnixSeconds = (date: Date): number => Math.floor(date.getTime() / 1000)

/** Truncate to the start of the minute → unix seconds. */
export const getMinutelyKey = (date: Date): number => Math.floor(toUnixSeconds(date) / 60) * 60

/** Truncate to the start of the hour → unix seconds. */
export const getHourlyKey = (date: Date): number => Math.floor(toUnixSeconds(date) / 3600) * 3600

/** Truncate to the start of the UTC day → unix seconds (UTC so timezone changes cannot skew it). */
export const getDailyKey = (date: Date): number => Math.floor(toUnixSeconds(date) / 86400) * 86400

export function getKey(date: Date, granularity: Granularity): number {
  switch (granularity) {
    case 'minute':
      return getMinutelyKey(date)
    case 'hour':
      return getHourlyKey(date)
    case 'day':
      return getDailyKey(date)
  }
}

/** Flatten a status to UP or DOWN: maintenance and degraded → up, pending → down. */
export function flatStatus(status: HeartbeatStatus): FlatStatus {
  switch (status) {
    case 'up':
    case 'degraded':
    case 'maintenance':
      return 'up'
    case 'down':
    case 'pending':
      return 'down'
  }
  throw new Error(`Invalid heartbeat status: ${String(status)}`)
}

export const emptyBucket = (): BucketData => ({
  up: 0,
  down: 0,
  ping: null,
  pingMin: null,
  pingMax: null,
  extras: {},
  latencyHistogram: null,
})

const isUsablePing = (ping: unknown): ping is number =>
  typeof ping === 'number' && Number.isFinite(ping) && ping >= 0

/**
 * Apply one heartbeat to a bucket and return the new bucket (the input is not mutated).
 * Only genuine `up` and `degraded` beats update the ping statistics; maintenance beats count as up but carry
 * no ping, and the running average stays exact because it is weighted by `extras.pingCount`.
 */
export function applyBeat(
  bucket: BucketData,
  status: HeartbeatStatus,
  ping: number | null | undefined,
  timing?: unknown,
): BucketData {
  const next: BucketData = { ...bucket, extras: { ...bucket.extras } }
  const flat = flatStatus(status)

  if (status === 'maintenance') {
    next.extras.maintenance = (next.extras.maintenance ?? 0) + 1
  }
  if (status === 'degraded') {
    next.extras.degraded = (next.extras.degraded ?? 0) + 1
  }

  if (flat === 'up') {
    next.up += 1
    if ((status === 'up' || status === 'degraded') && isUsablePing(ping)) {
      const count = (next.extras.pingCount ?? 0) + 1
      if (count === 1 || next.ping === null) {
        next.ping = ping
        next.pingMin = ping
        next.pingMax = ping
      } else {
        next.ping = (next.ping * (count - 1) + ping) / count
        next.pingMin = Math.min(next.pingMin ?? ping, ping)
        next.pingMax = Math.max(next.pingMax ?? ping, ping)
      }
      next.extras.pingCount = count
      next.latencyHistogram = addSample(bucket.latencyHistogram ?? null, ping)
    }
    // Request timing phases (#94) follow the ping: successful checks only.
    const phases = status === 'up' || status === 'degraded' ? parseRequestTiming(timing) : null
    if (phases) next.extras.timing = applyTiming(next.extras.timing, phases)
  } else {
    next.down += 1
    if (isUsablePing(ping) && ping > 0) {
      log.debug({ status }, 'ping is ignored while the status is DOWN')
    }
  }

  return next
}

/** Weight of a bucket's `ping` in a weighted average (falls back to `up` for legacy rows). */
export const pingWeight = (bucket: BucketData): number =>
  bucket.ping === null ? 0 : (bucket.extras?.pingCount ?? bucket.up)

/** Sum a list of buckets into uptime / average ping. */
export function summarize(buckets: readonly BucketData[]): UptimeDataResult {
  let up = 0
  let down = 0
  let pingTotal = 0
  let pingWeightTotal = 0
  let degraded = 0

  for (const bucket of buckets) {
    up += bucket.up
    down += bucket.down
    degraded += typeof bucket.extras?.degraded === 'number' ? bucket.extras.degraded : 0
    if (bucket.ping !== null) {
      const weight = pingWeight(bucket)
      pingTotal += bucket.ping * weight
      pingWeightTotal += weight
    }
  }

  return {
    uptime: up + down === 0 ? 0 : up / (up + down),
    avgPing: pingWeightTotal === 0 ? null : pingTotal / pingWeightTotal,
    degraded,
  }
}

/**
 * Inclusive `[from, to]` bucket keys covered by a range ending at `now`: the current bucket and
 * the `buckets - 1` before it.
 */
export function rangeWindow(range: StatsRange, now: Date): { from: number; to: number } {
  const spec = RANGE_SPECS[range]
  const to = getKey(now, spec.granularity)
  const from = to - BUCKET_SECONDS[spec.granularity] * (spec.buckets - 1)
  return { from, to }
}

// ---------------------------------------------------------------------------------------------
// Storage (Payload Local API)
// ---------------------------------------------------------------------------------------------

export type MonitorId = string | number

export type RecordHeartbeatInput = {
  monitorId: MonitorId
  organizationId: MonitorId
  status: HeartbeatStatus
  ping?: number | null
  /** Request timing phases of the beat (#94), rolled up as per-phase averages. */
  timing?: unknown
  /** Beat time; defaults to now. */
  time?: Date
}

type StatRow = Bucket & { id: MonitorId }

type RawStatRow = {
  id: MonitorId
  timestamp: number
  up?: number | null
  down?: number | null
  ping?: number | null
  pingMin?: number | null
  pingMax?: number | null
  extras?: unknown
  latencyHistogram?: unknown
}

const normalizeExtras = (extras: unknown): BucketExtras =>
  extras && typeof extras === 'object' && !Array.isArray(extras) ? (extras as BucketExtras) : {}

const toBucket = (row: RawStatRow): StatRow => ({
  id: row.id,
  timestamp: row.timestamp,
  up: row.up ?? 0,
  down: row.down ?? 0,
  ping: row.ping ?? null,
  pingMin: row.pingMin ?? null,
  pingMax: row.pingMax ?? null,
  extras: normalizeExtras(row.extras),
  latencyHistogram: parseHistogram(row.latencyHistogram),
})

const bucketToData = (bucket: BucketData) => ({
  up: bucket.up,
  down: bucket.down,
  ping: bucket.ping,
  pingMin: bucket.pingMin,
  pingMax: bucket.pingMax,
  extras: Object.keys(bucket.extras).length > 0 ? bucket.extras : null,
  latencyHistogram: bucket.latencyHistogram ?? null,
})

async function findBucket(
  payload: Payload,
  collection: StatCollectionSlug,
  monitorId: MonitorId,
  timestamp: number,
): Promise<StatRow | null> {
  const result = await payload.find({
    collection,
    where: { and: [{ monitor: { equals: monitorId } }, { timestamp: { equals: timestamp } }] },
    limit: 1,
    pagination: false,
    depth: 0,
  })
  const row = result.docs[0] as RawStatRow | undefined
  return row ? toBucket(row) : null
}

/**
 * Upsert one bucket: read the current row, apply the beat, write it back. A concurrent insert
 * of the same `(monitor, timestamp)` trips the unique index; in that case re-read and update
 * once, so no beat is lost.
 */
async function upsertBucket(
  payload: Payload,
  collection: StatCollectionSlug,
  input: Required<Pick<RecordHeartbeatInput, 'monitorId' | 'organizationId' | 'status'>> & {
    ping: number | null
    timing?: unknown
  },
  timestamp: number,
): Promise<Bucket> {
  const existing = await findBucket(payload, collection, input.monitorId, timestamp)

  if (existing) {
    const next = applyBeat(existing, input.status, input.ping, input.timing)
    await payload.update({ collection, id: existing.id, data: bucketToData(next), depth: 0 })
    return { ...next, timestamp }
  }

  const fresh = applyBeat(emptyBucket(), input.status, input.ping, input.timing)
  try {
    // Relationship ids are numbers on Postgres/SQLite and strings on MongoDB; the generated
    // types follow the adapter the types were generated with, so cast the adapter-neutral ids.
    const data = {
      monitor: input.monitorId,
      organization: input.organizationId,
      timestamp,
      ...bucketToData(fresh),
    } as unknown as RequiredDataFromCollectionSlug<StatCollectionSlug>
    await payload.create({ collection, data, depth: 0 })
    return { ...fresh, timestamp }
  } catch (error) {
    // Unique-violation race: another process created the row first. Re-read and update.
    const raced = await findBucket(payload, collection, input.monitorId, timestamp)
    if (!raced) throw error
    log.debug(
      { collection, monitorId: input.monitorId, timestamp },
      'bucket insert raced; updating',
    )
    const next = applyBeat(raced, input.status, input.ping, input.timing)
    await payload.update({ collection, id: raced.id, data: bucketToData(next), depth: 0 })
    return { ...next, timestamp }
  }
}

/**
 * Record one heartbeat into the minutely, hourly and daily buckets of a monitor.
 * Intended to be called from the engine's heartbeat listener (worker process, Local API).
 */
export async function recordHeartbeat(
  payload: Payload,
  input: RecordHeartbeatInput,
): Promise<Record<Granularity, Bucket>> {
  const time = input.time ?? new Date()
  const beat = {
    monitorId: input.monitorId,
    organizationId: input.organizationId,
    status: input.status,
    ping: isUsablePing(input.ping) ? input.ping : null,
    timing: input.timing,
  }

  const [minute, hour, day] = await Promise.all(
    GRANULARITIES.map((granularity) =>
      upsertBucket(
        payload,
        COLLECTION_BY_GRANULARITY[granularity],
        beat,
        getKey(time, granularity),
      ),
    ),
  )

  return { minute, hour, day }
}

export type ReadOptions = {
  /** Reference time for the range window; defaults to now. */
  now?: Date
}

/**
 * Buckets of a monitor inside the range window, oldest first. Only buckets that received at
 * least one beat exist; gaps mean the monitor was not checked (or was paused).
 */
export async function getBuckets(
  payload: Payload,
  monitorId: MonitorId,
  range: StatsRange,
  options: ReadOptions = {},
): Promise<Bucket[]> {
  const spec = RANGE_SPECS[range]
  const { from, to } = rangeWindow(range, options.now ?? new Date())

  const where: Where = {
    and: [
      { monitor: { equals: monitorId } },
      { timestamp: { greater_than_equal: from } },
      { timestamp: { less_than_equal: to } },
    ],
  }

  const result = await payload.find({
    collection: spec.collection,
    where,
    sort: 'timestamp',
    limit: spec.buckets,
    pagination: false,
    depth: 0,
  })

  return (result.docs as RawStatRow[]).map((row) => {
    const { id: _id, ...bucket } = toBucket(row)
    return bucket
  })
}

/**
 * Uptime and average ping over a range. When the window holds no data at all, fall back to the
 * most recent bucket of that granularity (as Uptime Kuma does) so a paused monitor keeps
 * showing its last known figures instead of 0 %.
 */
export async function getStats(
  payload: Payload,
  monitorId: MonitorId,
  range: StatsRange,
  options: ReadOptions = {},
): Promise<MonitorStats> {
  const spec = RANGE_SPECS[range]
  const buckets = await getBuckets(payload, monitorId, range, options)

  let summary = summarize(buckets)

  if (buckets.length === 0) {
    const latest = await payload.find({
      collection: spec.collection,
      where: { monitor: { equals: monitorId } },
      sort: '-timestamp',
      limit: 1,
      pagination: false,
      depth: 0,
    })
    const last = latest.docs[0] as RawStatRow | undefined
    if (last) summary = summarize([toBucket(last)])
  }

  return { range, granularity: spec.granularity, buckets, ...summary }
}

/** Uptime (0..1) of a monitor over `range`. */
export async function getUptime(
  payload: Payload,
  monitorId: MonitorId,
  range: StatsRange,
  options: ReadOptions = {},
): Promise<number> {
  return (await getStats(payload, monitorId, range, options)).uptime
}

/** Average ping (ms) of a monitor over `range`, or null without data. */
export async function getAvgPing(
  payload: Payload,
  monitorId: MonitorId,
  range: StatsRange,
  options: ReadOptions = {},
): Promise<number | null> {
  return (await getStats(payload, monitorId, range, options)).avgPing
}

/** Delete every aggregate row of a monitor (e.g. when the monitor is deleted or reset). */
export async function clearStatistics(payload: Payload, monitorId: MonitorId): Promise<void> {
  for (const granularity of GRANULARITIES) {
    await payload.delete({
      collection: COLLECTION_BY_GRANULARITY[granularity],
      where: { monitor: { equals: monitorId } },
      depth: 0,
    })
  }
}
