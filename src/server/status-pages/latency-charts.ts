/**
 * Public latency charts of status page components (#113). A monitor component shows charts only
 * when the page owner opted it in (`showChart`, off by default) and its values are public
 * (`showValues` on the page and the component). Everything comes from the stat rollups through
 * `getRangeStats()` / `getLocationStats()`, never from raw heartbeats, and the payload carries
 * aggregates only: no monitor id, target, URL, hostname or check message.
 */
import type { Payload } from 'payload'

import {
  PUBLIC_PERCENTILES,
  type PublicChartRange,
  type PublicPercentiles,
} from '@/lib/status-page-charts'
import { componentDisplayName } from '@/lib/status-page-components'
import { LOCAL_LOCATION, isMultiLocation, monitorLocationKeys } from '@/lib/probe-locations'
import type { Location, Monitor, StatusPage } from '@/payload-types'
import { getLocationStats } from '@/server/stats/location-stats'
import { bucketPercentiles, countChecks, getRangeStats } from '@/server/stats/range-stats'
import { summarize, type Bucket } from '@/server/stats/uptime-calculator'

import type { MonitorPublicStatus } from './public'

/** One chart interval. */
export interface PublicChartPoint extends PublicPercentiles {
  /** Unix seconds of the interval start. */
  timestamp: number
  /** Successful checks, degraded ones included. */
  up: number
  degraded: number
  /** Failed (down and pending) checks. */
  down: number
  /** Average response time of the interval in ms. */
  ping: number | null
}

/** Figures of one check location of a multi-location monitor over the period. */
export interface PublicChartLocation {
  /** Location name; null for the built-in workers (the page labels them). */
  name: string | null
  /** 0..1; only with `showUptimePercentage`, null without checks. */
  uptime?: number | null
  avgPing: number | null
  p95: number | null
}

export interface PublicComponentChart {
  componentId: string
  name: string
  description?: string
  status: MonitorPublicStatus
  range: PublicChartRange
  /** Interval width of `series` in seconds. */
  step: number
  /** 0..1 over the period; only with `showUptimePercentage`, null without checks. */
  uptime?: number | null
  avgPing: number | null
  percentiles: PublicPercentiles
  checks: { total: number; up: number; failed: number; degraded: number }
  /** Oldest first; empty intervals have zero counts and null pings. */
  series: PublicChartPoint[]
  /** Per-location breakdown (#92); empty unless the monitor is checked from several locations. */
  locations: PublicChartLocation[]
}

type GroupRow = NonNullable<StatusPage['groups']>[number]
type ComponentRow = NonNullable<GroupRow['monitors']>[number]

const relId = (value: unknown): string | number | null => {
  if (value === null || value === undefined || value === '') return null
  if (typeof value === 'string' || typeof value === 'number') return value
  if (typeof value === 'object' && 'id' in value) {
    const id = (value as { id: unknown }).id
    if (typeof id === 'string' || typeof id === 'number') return id
  }
  return null
}

/**
 * True when the row publishes charts: a monitor component the owner opted in, whose values the
 * page and the component show.
 */
export const rowShowsChart = (
  page: Pick<StatusPage, 'showValues'>,
  row: Pick<ComponentRow, 'type' | 'showChart' | 'showValues'>,
): boolean =>
  row.type !== 'static' &&
  row.showChart === true &&
  page.showValues !== false &&
  row.showValues !== false

/** Monitors that never record a response time of their own (vendor status pages, #125). */
const NO_CHART_TYPES = new Set<string>(['status-page'])

export interface ChartComponent {
  row: ComponentRow
  monitor: Monitor
}

/**
 * The page's charted components, in page order: opted-in rows whose monitor belongs to the page's
 * organization and is active (paused monitors are hidden from the page). `componentId` limits the
 * result to that row.
 */
export async function findChartComponents(
  payload: Payload,
  page: StatusPage,
  componentId?: string,
): Promise<ChartComponent[]> {
  const rows = (page.groups ?? [])
    .flatMap((group) => group.monitors ?? [])
    .filter(
      (row) =>
        row.id &&
        rowShowsChart(page, row) &&
        relId(row.monitor) !== null &&
        (componentId === undefined || String(row.id) === componentId),
    )
  if (rows.length === 0) return []
  const ids = [...new Set(rows.map((row) => String(relId(row.monitor))))]
  const { docs } = await payload.find({
    collection: 'monitors',
    where: {
      and: [
        { id: { in: ids } },
        { organization: { equals: relId(page.organization) } },
        { active: { equals: true } },
      ],
    },
    depth: 0,
    limit: ids.length,
    pagination: false,
    overrideAccess: true,
  })
  const byId = new Map(docs.map((monitor) => [String(monitor.id), monitor]))
  return rows.flatMap((row) => {
    const monitor = byId.get(String(relId(row.monitor)))
    return monitor && !NO_CHART_TYPES.has(monitor.type) ? [{ row, monitor }] : []
  })
}

const pickPercentiles = (values: Partial<PublicPercentiles>): PublicPercentiles => ({
  p50: values.p50 ?? null,
  p95: values.p95 ?? null,
  p99: values.p99 ?? null,
})

/** Window start (unix seconds) of the location rows for a range. */
const locationWindowStart = (range: PublicChartRange, now: Date): number =>
  Math.floor(now.getTime() / 1000) -
  (range === '1d' ? 24 : range === '7d' ? 7 * 24 : 30 * 24) * 3600

async function locationBreakdown(
  payload: Payload,
  monitor: Monitor,
  range: PublicChartRange,
  showPercentage: boolean,
  now: Date,
): Promise<PublicChartLocation[]> {
  if (!isMultiLocation(monitor)) return []
  const keys = monitorLocationKeys(monitor)
  const remote = keys.filter((key) => key !== LOCAL_LOCATION)
  const [stats, locations] = await Promise.all([
    getLocationStats(payload, monitor.id, range === '1d' ? '24h' : '30d', { now }),
    remote.length === 0
      ? Promise.resolve([] as Location[])
      : payload
          .find({
            collection: 'locations',
            where: {
              and: [
                { id: { in: remote } },
                { organization: { equals: relId(monitor.organization) } },
              ],
            },
            depth: 0,
            limit: remote.length,
            pagination: false,
            overrideAccess: true,
            select: { name: true },
          })
          .then((result) => result.docs as Location[]),
  ])
  const names = new Map(locations.map((doc) => [String(doc.id), doc.name]))
  const from = locationWindowStart(range, now)
  return keys.flatMap((key): PublicChartLocation[] => {
    // A location that no longer exists (or belongs elsewhere) is left out rather than shown by id.
    if (key !== LOCAL_LOCATION && !names.has(key)) return []
    const buckets: Bucket[] = (stats.get(key)?.buckets ?? []).filter((b) => b.timestamp >= from)
    const summary = summarize(buckets)
    const total = countChecks(buckets).total
    return [
      {
        name: key === LOCAL_LOCATION ? null : (names.get(key) ?? null),
        ...(showPercentage ? { uptime: total > 0 ? summary.uptime : null } : {}),
        avgPing: summary.avgPing,
        p95: bucketPercentiles(buckets, ['p95']).p95 ?? null,
      },
    ]
  })
}

/** The public chart data of one charted component over `range`. */
export async function buildComponentChart(
  payload: Payload,
  page: StatusPage,
  { row, monitor }: ChartComponent,
  range: PublicChartRange,
  now: Date = new Date(),
): Promise<PublicComponentChart> {
  const showPercentage = page.showUptimePercentage !== false
  const [stats, locations] = await Promise.all([
    getRangeStats(payload, monitor.id, range, { now, percentiles: PUBLIC_PERCENTILES }),
    locationBreakdown(payload, monitor, range, showPercentage, now),
  ])
  const description = row.description?.trim()
  const { total, up, failed, degraded } = stats.checks
  return {
    componentId: String(row.id),
    name: componentDisplayName(row.name, monitor),
    ...(description ? { description } : {}),
    status: monitor.status?.lastStatus ?? 'unknown',
    range,
    step: stats.step,
    ...(showPercentage ? { uptime: total > 0 ? stats.uptime : null } : {}),
    avgPing: stats.avgPing,
    percentiles: pickPercentiles(stats.percentiles),
    checks: { total, up, failed, degraded },
    series: stats.series.map((point) => ({
      timestamp: point.timestamp,
      up: point.up,
      degraded: point.degraded,
      down: point.down,
      ping: point.ping,
      ...pickPercentiles(point),
    })),
    locations,
  }
}

/** Charts of every charted component of the page (`componentId`: just that one). */
export async function buildPageCharts(
  payload: Payload,
  page: StatusPage,
  range: PublicChartRange,
  options: { componentId?: string; now?: Date } = {},
): Promise<PublicComponentChart[]> {
  const components = await findChartComponents(payload, page, options.componentId)
  const now = options.now ?? new Date()
  return Promise.all(
    components.map((component) => buildComponentChart(payload, page, component, range, now)),
  )
}
