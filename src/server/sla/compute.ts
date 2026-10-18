/**
 * SLA figures of monitors (#156), read from the same sources as the status page uptime of #112:
 * check counts from the `stat-hourly` / `stat-daily` buckets and the important heartbeats replayed
 * for the time spent DOWN or in maintenance, plus the monitor incidents of the period. The maths
 * lives in `src/lib/sla.ts`.
 *
 * A target counts a list of intervals (#274): its period, cut in the organization's time zone, or
 * only the business hours of its calendar. Durations are exact (the transitions are replayed over
 * each interval). Check counts come in UTC buckets, so a bucket that is only partly counted
 * contributes the same share of its checks: hourly buckets where they are still kept (30 days) and
 * complete, daily buckets otherwise. With whole UTC days counted this is exactly the daily figure.
 * Only the UTC days with a `stat-daily` row (the monitor was checked) count, as on status pages.
 *
 * Everything here reads with `overrideAccess: true`; callers load the target or report as the
 * user first (or hold a valid share token).
 */
import type { Payload, Where } from 'payload'

import {
  businessHoursOf,
  clipIntervals,
  countedIntervals,
  currentPeriod,
  emptySlaFigures,
  intervalsSeconds,
  isSlaCalculation,
  isSlaWindow,
  meanTimeToRecovery,
  overlapMs,
  periodDates,
  slaAttainment,
  slaHealth,
  type SlaAttainment,
  type SlaBusinessHours,
  type SlaCalculation,
  type SlaFigures,
  type SlaHealth,
  type SlaPeriod,
  type SlaReportData,
  type SlaReportRow,
  type SlaTargetSpec,
  type SlaWindow,
  type SlaZone,
  type TimeInterval,
} from '@/lib/sla'
import {
  DAY_SECONDS,
  replayStatuses,
  utcDayStart,
  type BeatStatus,
  type StatusChange,
} from '@/lib/uptime-history'
import type { Monitor, MonitorIncident, SlaReport, SlaTarget } from '@/payload-types'
import { relationId } from '@/server/maintenance/serialize'
import { MAX_TRANSITIONS } from '@/server/status-pages/uptime-history'

import { loadSlaZones } from './zone'

/** Most incidents listed per target and period. */
export const MAX_PERIOD_INCIDENTS = 500

const DAY_MS = DAY_SECONDS * 1000
const HOUR_MS = 3_600_000

type Id = string | number

/** A target with its monitor's name and status, as the computations need it. */
export interface ResolvedTarget extends SlaTargetSpec {
  id: string
  organization: Id | null
  monitorId: Id
  monitorName: string
  lastStatus: BeatStatus | null
  period: SlaWindow
  businessHours: SlaBusinessHours | null
}

type Bucket = { timestamp: number; up?: number | null; down?: number | null; extras?: unknown }

const maintenanceOf = (extras: unknown): number => {
  if (!extras || typeof extras !== 'object' || Array.isArray(extras)) return 0
  const value = (extras as Record<string, unknown>).maintenance
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

const checksOf = (bucket: Bucket) => (bucket.up ?? 0) + (bucket.down ?? 0)

/**
 * Figures of a monitor over the elapsed part of `intervals` (sorted, disjoint; usually
 * `countedIntervals` of a period).
 */
export async function loadSlaFigures(
  payload: Payload,
  monitor: { id: Id; lastStatus?: BeatStatus | null },
  intervals: readonly TimeInterval[],
  now: Date,
): Promise<SlaFigures> {
  const figures = emptySlaFigures()
  const counted = clipIntervals(intervals, Number.NEGATIVE_INFINITY, now.getTime())
  if (counted.length === 0) return figures
  const firstDay = utcDayStart(counted[0].from)
  const lastDay = utcDayStart(counted[counted.length - 1].to - 1)
  const end = Math.min((lastDay + DAY_SECONDS) * 1000, now.getTime())
  const fromIso = new Date(firstDay * 1000).toISOString()
  const toIso = new Date(end).toISOString()
  const range: Where[] = [
    { monitor: { equals: monitor.id } },
    { timestamp: { greater_than_equal: firstDay } },
    { timestamp: { less_than: lastDay + DAY_SECONDS } },
  ]

  const [daily, hourly, changes, prior] = await Promise.all([
    payload.find({
      collection: 'stat-daily',
      where: { and: range },
      sort: 'timestamp',
      limit: 0,
      pagination: false,
      depth: 0,
      overrideAccess: true,
      select: { timestamp: true, up: true, down: true, extras: true },
    }),
    payload.find({
      collection: 'stat-hourly',
      where: { and: range },
      sort: 'timestamp',
      limit: 0,
      pagination: false,
      depth: 0,
      overrideAccess: true,
      select: { timestamp: true, up: true, down: true, extras: true },
    }),
    payload.find({
      collection: 'heartbeats',
      where: {
        and: [
          { monitor: { equals: monitor.id } },
          { important: { equals: true } },
          { time: { greater_than_equal: fromIso } },
          { time: { less_than: toIso } },
        ],
      },
      sort: 'time',
      limit: MAX_TRANSITIONS,
      pagination: false,
      depth: 0,
      overrideAccess: true,
      select: { status: true, time: true },
    }),
    payload.find({
      collection: 'heartbeats',
      where: {
        and: [
          { monitor: { equals: monitor.id } },
          { important: { equals: true } },
          { time: { less_than: fromIso } },
        ],
      },
      sort: '-time',
      limit: 1,
      pagination: false,
      depth: 0,
      overrideAccess: true,
      select: { status: true, time: true },
    }),
  ])
  if (daily.docs.length === 0) return figures

  const transitions: StatusChange[] = changes.docs.map((beat) => ({
    time: Date.parse(beat.time),
    status: beat.status as BeatStatus,
  }))
  // Without any transition in the window the status never changed: it is the current one.
  const initial: BeatStatus | null =
    (prior.docs[0]?.status as BeatStatus | undefined) ??
    (transitions.length === 0 ? (monitor.lastStatus ?? null) : null)

  const hoursByDay = new Map<number, Bucket[]>()
  for (const bucket of hourly.docs as Bucket[]) {
    const day = utcDayStart(bucket.timestamp * 1000)
    const list = hoursByDay.get(day) ?? []
    list.push(bucket)
    hoursByDay.set(day, list)
  }

  const addChecks = (bucket: Bucket, weight: number) => {
    if (weight <= 0) return
    figures.up += (bucket.up ?? 0) * weight
    figures.down += (bucket.down ?? 0) * weight
    figures.maintenanceChecks += maintenanceOf(bucket.extras) * weight
  }

  for (const row of daily.docs as Bucket[]) {
    const dayFrom = row.timestamp * 1000
    const dayTo = Math.min(dayFrom + DAY_MS, now.getTime())
    const parts = clipIntervals(counted, dayFrom, dayTo)
    if (parts.length === 0) continue

    for (const part of parts) {
      const replay = replayStatuses(initial, transitions, part.from, part.to)
      figures.downSeconds += replay.downSeconds
      figures.knownSeconds += replay.knownSeconds
      figures.maintenanceSeconds += replay.maintenanceSeconds
    }
    const countedMs = overlapMs(parts, dayFrom, dayTo)
    figures.elapsedSeconds += countedMs / 1000

    if (countedMs >= dayTo - dayFrom) {
      addChecks(row, 1)
      continue
    }
    // Part of the day counts: its share of the checks, hour by hour while the hourly buckets
    // are kept and hold all of the day's checks, otherwise in proportion to the day.
    const hours = hoursByDay.get(row.timestamp) ?? []
    if (hours.length > 0 && hours.reduce((sum, h) => sum + checksOf(h), 0) >= checksOf(row)) {
      for (const hour of hours) {
        const hourFrom = hour.timestamp * 1000
        const hourTo = Math.min(hourFrom + HOUR_MS, now.getTime())
        if (hourTo <= hourFrom) continue
        addChecks(hour, overlapMs(parts, hourFrom, hourTo) / (hourTo - hourFrom))
      }
    } else {
      addChecks(row, countedMs / (dayTo - dayFrom))
    }
  }
  return figures
}

export interface PeriodIncident {
  id: string
  cause: string | null
  status: MonitorIncident['status']
  startedAt: string
  resolvedAt: string | null
}

/** Monitor incidents overlapping `period` (started before its end, not resolved before its start). */
export async function loadPeriodIncidents(
  payload: Payload,
  monitorId: Id,
  period: Pick<SlaPeriod, 'from' | 'to'>,
): Promise<PeriodIncident[]> {
  const { docs } = await payload.find({
    collection: 'monitor-incidents',
    where: {
      and: [
        { monitor: { equals: monitorId } },
        { startedAt: { less_than: new Date(period.to).toISOString() } },
        {
          or: [
            { resolvedAt: { greater_than_equal: new Date(period.from).toISOString() } },
            { status: { not_equals: 'resolved' } },
          ],
        },
      ],
    },
    sort: 'startedAt',
    limit: MAX_PERIOD_INCIDENTS,
    pagination: false,
    depth: 0,
    overrideAccess: true,
    select: { cause: true, status: true, startedAt: true, resolvedAt: true },
  })
  return (docs as MonitorIncident[]).map((doc) => ({
    id: String(doc.id),
    cause: doc.cause ?? null,
    status: doc.status,
    startedAt: doc.startedAt,
    resolvedAt: doc.resolvedAt ?? null,
  }))
}

/**
 * Targets with their monitors (one query for all monitors). Targets whose monitor is gone are
 * left out.
 */
export async function resolveTargets(
  payload: Payload,
  targets: readonly SlaTarget[],
): Promise<ResolvedTarget[]> {
  const monitorIds = [
    ...new Set(targets.map((t) => relationId(t.monitor)).filter((id) => id !== null)),
  ] as Id[]
  if (monitorIds.length === 0) return []
  const { docs } = await payload.find({
    collection: 'monitors',
    where: { id: { in: monitorIds } },
    depth: 0,
    limit: monitorIds.length,
    pagination: false,
    overrideAccess: true,
    select: { name: true, status: true },
  })
  const monitors = new Map((docs as Monitor[]).map((m) => [String(m.id), m]))
  return targets.flatMap((target) => {
    const monitor = monitors.get(String(relationId(target.monitor)))
    if (!monitor) return []
    return [
      {
        id: String(target.id),
        organization: relationId(target.organization),
        monitorId: monitor.id,
        monitorName: monitor.name,
        lastStatus: (monitor.status?.lastStatus as BeatStatus | null | undefined) ?? null,
        target: target.target,
        period: isSlaWindow(target.period) ? target.period : 'month',
        calculation: isSlaCalculation(target.calculation)
          ? target.calculation
          : ('duration' as SlaCalculation),
        excludeMaintenance: target.excludeMaintenance !== false,
        businessHours: businessHoursOf(target),
      },
    ]
  })
}

/** Attainment of a resolved target over a period (the counted part of it). */
async function evaluate(
  payload: Payload,
  target: ResolvedTarget,
  period: SlaPeriod,
  zone: SlaZone,
  now: Date,
) {
  const counted = countedIntervals(period, target.businessHours, zone.timeZone)
  const [figures, incidents] = await Promise.all([
    loadSlaFigures(payload, { id: target.monitorId, lastStatus: target.lastStatus }, counted, now),
    loadPeriodIncidents(payload, target.monitorId, period),
  ])
  const countedSeconds = intervalsSeconds(counted)
  const elapsedSeconds = intervalsSeconds(clipIntervals(counted, period.from, now.getTime()))
  return {
    figures,
    incidents,
    attainment: slaAttainment(target, figures, countedSeconds),
    /** Share of the counted time elapsed, 0..1. */
    elapsed: countedSeconds > 0 ? Math.min(1, elapsedSeconds / countedSeconds) : 0,
  }
}

const zoneOf = (zones: Map<string, SlaZone>, organization: Id | null): SlaZone =>
  zones.get(String(organization)) ?? { timeZone: 'UTC', weekStart: 'monday' }

// ---- Dashboard --------------------------------------------------------------------------------------

export interface TargetStatus {
  id: string
  monitorId: string
  monitorName: string
  target: number
  period: SlaWindow
  calculation: SlaCalculation
  excludeMaintenance: boolean
  /** The business-hours calendar, null when the whole period counts (#274). */
  businessHours: SlaBusinessHours | null
  /** Inclusive `YYYY-MM-DD` dates of the current period, in the organization's time zone. */
  from: string
  to: string
  /** Share of the period's counted time elapsed, 0..1. */
  elapsed: number
  attainment: SlaAttainment
  health: SlaHealth
  /** Incidents of the period: what consumed the budget. */
  incidents: PeriodIncident[]
}

/** Current-period attainment, budget and incidents of each target. */
export async function targetStatuses(
  payload: Payload,
  targets: readonly SlaTarget[],
  now: Date = new Date(),
): Promise<TargetStatus[]> {
  const resolved = await resolveTargets(payload, targets)
  const zones = await loadSlaZones(
    payload,
    resolved.map((target) => target.organization),
  )
  return Promise.all(
    resolved.map(async (target) => {
      const zone = zoneOf(zones, target.organization)
      const period = currentPeriod(target.period, now, zone)
      const { attainment, incidents, elapsed } = await evaluate(payload, target, period, zone, now)
      return {
        id: target.id,
        monitorId: String(target.monitorId),
        monitorName: target.monitorName,
        target: target.target,
        period: target.period,
        calculation: target.calculation,
        excludeMaintenance: target.excludeMaintenance,
        businessHours: target.businessHours,
        ...periodDates(period, zone),
        elapsed,
        attainment,
        health: slaHealth(attainment),
        incidents,
      }
    }),
  )
}

// ---- Reports ----------------------------------------------------------------------------------------

/** The report's targets (same organization), in the report's order. */
export async function reportTargets(payload: Payload, report: SlaReport): Promise<SlaTarget[]> {
  const ids = (report.targets ?? []).map((t) => relationId(t)).filter((id) => id !== null) as Id[]
  if (ids.length === 0) return []
  const { docs } = await payload.find({
    collection: 'sla-targets',
    where: {
      and: [{ id: { in: ids } }, { organization: { equals: relationId(report.organization) } }],
    },
    depth: 0,
    limit: ids.length,
    pagination: false,
    overrideAccess: true,
  })
  const byId = new Map((docs as SlaTarget[]).map((doc) => [String(doc.id), doc]))
  return ids.flatMap((id) => byId.get(String(id)) ?? [])
}

/**
 * One row per target of the report over `period` (local days of the organization's time zone,
 * see `periodFromDates`).
 */
export async function buildSlaReport(
  payload: Payload,
  report: SlaReport,
  period: SlaPeriod,
  now: Date = new Date(),
): Promise<SlaReportData> {
  const organization = relationId(report.organization)
  const [resolved, zones] = await Promise.all([
    reportTargets(payload, report).then((targets) => resolveTargets(payload, targets)),
    loadSlaZones(payload, [organization]),
  ])
  const zone = zoneOf(zones, organization)
  const rows: SlaReportRow[] = await Promise.all(
    resolved.map(async (target) => {
      const { figures, incidents, attainment } = await evaluate(payload, target, period, zone, now)
      return {
        targetId: target.id,
        name: target.monitorName,
        target: target.target,
        calculation: target.calculation,
        excludeMaintenance: target.excludeMaintenance,
        businessHours: target.businessHours !== null,
        uptime: attainment.uptime,
        downtimeSeconds: figures.knownSeconds > 0 ? figures.downSeconds : null,
        incidents: incidents.length,
        mttrSeconds: meanTimeToRecovery(incidents),
        met: attainment.met,
        budgetSeconds: attainment.budgetSeconds,
        remainingSeconds: attainment.remainingSeconds,
      }
    }),
  )
  return {
    name: report.name,
    ...periodDates(period, zone),
    timeZone: zone.timeZone,
    generatedAt: now.toISOString(),
    rows,
  }
}
