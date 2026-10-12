/**
 * SLA figures of monitors (#156), read from the same sources as the status page uptime of #112:
 * `stat-daily` check counts and the important heartbeats replayed for the time spent DOWN or in
 * maintenance (`loadMonitorDays`), plus the monitor incidents of the period. The maths lives in
 * `src/lib/sla.ts`.
 *
 * Everything here reads with `overrideAccess: true`; callers load the target or report as the
 * user first (or hold a valid share token).
 */
import type { Payload } from 'payload'

import {
  currentPeriod,
  emptySlaFigures,
  isSlaCalculation,
  isSlaWindow,
  meanTimeToRecovery,
  periodDates,
  periodDays,
  periodSeconds,
  slaAttainment,
  slaHealth,
  type SlaAttainment,
  type SlaCalculation,
  type SlaFigures,
  type SlaHealth,
  type SlaPeriod,
  type SlaReportData,
  type SlaReportRow,
  type SlaTargetSpec,
  type SlaWindow,
} from '@/lib/sla'
import type { BeatStatus } from '@/lib/uptime-history'
import type { Monitor, MonitorIncident, SlaReport, SlaTarget } from '@/payload-types'
import { relationId } from '@/server/maintenance/serialize'
import { loadMonitorDays } from '@/server/status-pages/uptime-history'

/** Most incidents listed per target and period. */
export const MAX_PERIOD_INCIDENTS = 500

type Id = string | number

/** A target with its monitor's name and status, as the computations need it. */
export interface ResolvedTarget extends SlaTargetSpec {
  id: string
  monitorId: Id
  monitorName: string
  lastStatus: BeatStatus | null
  period: SlaWindow
}

/** Figures of a monitor over the elapsed part of `period`. */
export async function loadSlaFigures(
  payload: Payload,
  monitor: { id: Id; lastStatus?: BeatStatus | null },
  period: Pick<SlaPeriod, 'from' | 'to'>,
  now: Date,
): Promise<SlaFigures> {
  const days = periodDays(period).filter((day) => day * 1000 < now.getTime())
  const live = await loadMonitorDays(payload, monitor, days, now)
  const figures = emptySlaFigures()
  for (const day of live.values()) {
    figures.up += day.figures.up
    figures.down += day.figures.down
    figures.maintenanceChecks += day.maintenance
    figures.downSeconds += day.figures.downSeconds
    figures.knownSeconds += day.figures.knownSeconds
    figures.maintenanceSeconds += day.maintenanceSeconds
    figures.elapsedSeconds += day.figures.elapsedSeconds
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
        monitorId: monitor.id,
        monitorName: monitor.name,
        lastStatus: (monitor.status?.lastStatus as BeatStatus | null | undefined) ?? null,
        target: target.target,
        period: isSlaWindow(target.period) ? target.period : 'month',
        calculation: isSlaCalculation(target.calculation)
          ? target.calculation
          : ('duration' as SlaCalculation),
        excludeMaintenance: target.excludeMaintenance !== false,
      },
    ]
  })
}

// ---- Dashboard --------------------------------------------------------------------------------------

export interface TargetStatus {
  id: string
  monitorId: string
  monitorName: string
  target: number
  period: SlaWindow
  calculation: SlaCalculation
  excludeMaintenance: boolean
  /** Inclusive `YYYY-MM-DD` dates of the current period. */
  from: string
  to: string
  /** Share of the period elapsed, 0..1. */
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
  return Promise.all(
    resolved.map(async (target) => {
      const period = currentPeriod(target.period, now)
      const [figures, incidents] = await Promise.all([
        loadSlaFigures(
          payload,
          { id: target.monitorId, lastStatus: target.lastStatus },
          period,
          now,
        ),
        loadPeriodIncidents(payload, target.monitorId, period),
      ])
      const attainment = slaAttainment(target, figures, periodSeconds(period))
      const total = period.to - period.from
      return {
        id: target.id,
        monitorId: String(target.monitorId),
        monitorName: target.monitorName,
        target: target.target,
        period: target.period,
        calculation: target.calculation,
        excludeMaintenance: target.excludeMaintenance,
        ...periodDates(period),
        elapsed: total > 0 ? Math.min(1, Math.max(0, (now.getTime() - period.from) / total)) : 0,
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

/** One row per target of the report over `period`. */
export async function buildSlaReport(
  payload: Payload,
  report: SlaReport,
  period: SlaPeriod,
  now: Date = new Date(),
): Promise<SlaReportData> {
  const resolved = await resolveTargets(payload, await reportTargets(payload, report))
  const rows: SlaReportRow[] = await Promise.all(
    resolved.map(async (target) => {
      const [figures, incidents] = await Promise.all([
        loadSlaFigures(
          payload,
          { id: target.monitorId, lastStatus: target.lastStatus },
          period,
          now,
        ),
        loadPeriodIncidents(payload, target.monitorId, period),
      ])
      const attainment = slaAttainment(target, figures, periodSeconds(period))
      return {
        targetId: target.id,
        name: target.monitorName,
        target: target.target,
        calculation: target.calculation,
        excludeMaintenance: target.excludeMaintenance,
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
    ...periodDates(period),
    generatedAt: now.toISOString(),
    rows,
  }
}
