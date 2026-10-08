/**
 * Per-location statistics of multi-location monitors (#92): a separate series
 * (`stat-location-hourly`, one row per monitor, location and hour) next to the monitor-wide
 * `stat-*` rollups, which keep counting the monitor's quorum status. Same maths as the uptime
 * calculator (`applyBeat`, `summarize`), so the figures read the same way.
 */
import type { Payload, Where } from 'payload'

import { childLogger } from '@/lib/logger'
import type { StatLocationHourly } from '@/payload-types'

import {
  applyBeat,
  BUCKET_SECONDS,
  emptyBucket,
  getHourlyKey,
  summarize,
  type Bucket,
  type BucketData,
  type BucketExtras,
  type HeartbeatStatus,
  type MonitorId,
  type UptimeDataResult,
} from './uptime-calculator'

const log = childLogger('stats:location')

const COLLECTION = 'stat-location-hourly'

/** Ranges the per-location series serves (hourly buckets, kept 30 days). */
export const LOCATION_STATS_RANGES = ['24h', '30d'] as const
export type LocationStatsRange = (typeof LOCATION_STATS_RANGES)[number]

const RANGE_HOURS: Record<LocationStatsRange, number> = { '24h': 24, '30d': 30 * 24 }

export const isLocationStatsRange = (value: unknown): value is LocationStatsRange =>
  typeof value === 'string' && (LOCATION_STATS_RANGES as readonly string[]).includes(value)

export interface RecordLocationHeartbeatInput {
  monitorId: MonitorId
  organizationId: MonitorId
  /** Location key: the location's id, or `local`. */
  location: string
  status: HeartbeatStatus
  ping?: number | null
  time?: Date
}

const toBucket = (row: StatLocationHourly): Bucket => ({
  timestamp: row.timestamp,
  up: row.up ?? 0,
  down: row.down ?? 0,
  ping: row.ping ?? null,
  pingMin: row.pingMin ?? null,
  pingMax: row.pingMax ?? null,
  extras:
    row.extras && typeof row.extras === 'object' && !Array.isArray(row.extras)
      ? (row.extras as BucketExtras)
      : {},
})

const toData = (bucket: BucketData) => ({
  up: bucket.up,
  down: bucket.down,
  ping: bucket.ping,
  pingMin: bucket.pingMin,
  pingMax: bucket.pingMax,
  extras: Object.keys(bucket.extras).length > 0 ? bucket.extras : null,
})

async function findRow(
  payload: Payload,
  input: RecordLocationHeartbeatInput,
  timestamp: number,
): Promise<StatLocationHourly | null> {
  const { docs } = await payload.find({
    collection: COLLECTION,
    where: {
      and: [
        { monitor: { equals: input.monitorId } },
        { location: { equals: input.location } },
        { timestamp: { equals: timestamp } },
      ],
    },
    limit: 1,
    pagination: false,
    depth: 0,
  })
  return (docs[0] as StatLocationHourly | undefined) ?? null
}

/** Fold one location beat into its hourly bucket (read-modify-write, insert races retried). */
export async function recordLocationHeartbeat(
  payload: Payload,
  input: RecordLocationHeartbeatInput,
): Promise<Bucket> {
  const timestamp = getHourlyKey(input.time ?? new Date())
  const ping = typeof input.ping === 'number' && Number.isFinite(input.ping) ? input.ping : null
  const update = async (row: StatLocationHourly) => {
    const next = applyBeat(toBucket(row), input.status, ping)
    await payload.update({ collection: COLLECTION, id: row.id, data: toData(next), depth: 0 })
    return { ...next, timestamp }
  }
  const existing = await findRow(payload, input, timestamp)
  if (existing) return update(existing)
  const fresh = applyBeat(emptyBucket(), input.status, ping)
  try {
    await payload.create({
      collection: COLLECTION,
      data: {
        monitor: input.monitorId,
        organization: input.organizationId,
        location: input.location,
        timestamp,
        ...toData(fresh),
      } as unknown as StatLocationHourly,
      depth: 0,
    })
    return { ...fresh, timestamp }
  } catch (err) {
    const raced = await findRow(payload, input, timestamp)
    if (!raced) throw err
    log.debug({ monitorId: input.monitorId, location: input.location }, 'insert raced; updating')
    return update(raced)
  }
}

export type LocationStats = UptimeDataResult & { location: string; buckets: Bucket[] }

/**
 * Uptime, average ping and hourly buckets per location over `range` (the current hour and the
 * ones before it), oldest bucket first. Locations without a beat in the window are absent.
 */
export async function getLocationStats(
  payload: Payload,
  monitorId: MonitorId,
  range: LocationStatsRange,
  options: { now?: Date; locations?: readonly string[] } = {},
): Promise<Map<string, LocationStats>> {
  const to = getHourlyKey(options.now ?? new Date())
  const from = to - BUCKET_SECONDS.hour * (RANGE_HOURS[range] - 1)
  const and: Where[] = [
    { monitor: { equals: monitorId } },
    { timestamp: { greater_than_equal: from } },
    { timestamp: { less_than_equal: to } },
  ]
  if (options.locations) and.push({ location: { in: [...options.locations] } })
  const { docs } = await payload.find({
    collection: COLLECTION,
    where: { and },
    sort: 'timestamp',
    limit: 0,
    pagination: false,
    depth: 0,
  })
  const byLocation = new Map<string, Bucket[]>()
  for (const row of docs as StatLocationHourly[]) {
    const list = byLocation.get(row.location) ?? []
    list.push(toBucket(row))
    byLocation.set(row.location, list)
  }
  return new Map(
    [...byLocation].map(([location, buckets]) => [
      location,
      { location, buckets, ...summarize(buckets) },
    ]),
  )
}
