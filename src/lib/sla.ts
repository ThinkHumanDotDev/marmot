/**
 * SLA targets and reports (#156): periods, attainment, error budget and the report export. Pure
 * functions only (no Payload imports), so the server, the worker and the browser share them.
 *
 * The figures come from the same sources as the status page uptime of #112 (`stat-daily` check
 * counts and the replayed important heartbeats, see `src/lib/uptime-history.ts`), under one of two
 * calculation modes:
 *
 * - `duration` (default): time not DOWN / time with a known state;
 * - `checks`: successful checks / all checks (degraded and maintenance beats count as successful,
 *   pending ones as failed, as in the stat rollups).
 *
 * With `excludeMaintenance` the maintenance windows leave the calculation: their time (duration)
 * or their beats (checks) are removed from both sides of the ratio, and from the period the error
 * budget is computed on.
 *
 * Periods are UTC days, like the daily buckets they are read from.
 */
import { csvCell, DAY_SECONDS, utcDayStart } from '@/lib/uptime-history'

export const SLA_WINDOWS = ['month', 'quarter', 'rolling30'] as const
export type SlaWindow = (typeof SLA_WINDOWS)[number]

export const SLA_CALCULATIONS = ['duration', 'checks'] as const
export type SlaCalculation = (typeof SLA_CALCULATIONS)[number]

export const SLA_SCHEDULES = ['none', 'weekly', 'monthly'] as const
export type SlaSchedule = (typeof SLA_SCHEDULES)[number]

/** Bounds of a target, in percent. 100 % would leave no error budget at all. */
export const SLA_TARGET_MIN = 50
export const SLA_TARGET_MAX = 99.9999

/** Longest report range, in days (about the longest `stat-daily` retention worth reporting on). */
export const SLA_MAX_REPORT_DAYS = 400

/** Most recipients of a scheduled report. */
export const SLA_MAX_RECIPIENTS = 20

const DAY_MS = DAY_SECONDS * 1000

export const isSlaWindow = (value: unknown): value is SlaWindow =>
  typeof value === 'string' && (SLA_WINDOWS as readonly string[]).includes(value)

export const isSlaCalculation = (value: unknown): value is SlaCalculation =>
  typeof value === 'string' && (SLA_CALCULATIONS as readonly string[]).includes(value)

export const isSlaSchedule = (value: unknown): value is SlaSchedule =>
  typeof value === 'string' && (SLA_SCHEDULES as readonly string[]).includes(value)

// ---- Periods ---------------------------------------------------------------------------------------

/** A half-open range of whole UTC days, `[from, to)` in epoch milliseconds. */
export interface SlaPeriod {
  from: number
  to: number
  /** Stable identifier (`2026-09`, `2026-Q3`, `week:2026-09-28`, `2026-09-01..2026-09-30`). */
  key: string
}

const isoDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10)

/** Seconds covered by a period. */
export const periodSeconds = (period: Pick<SlaPeriod, 'from' | 'to'>): number =>
  Math.max(0, (period.to - period.from) / 1000)

/** UTC day starts (unix seconds) of a period, oldest first. */
export function periodDays(period: Pick<SlaPeriod, 'from' | 'to'>): number[] {
  const days: number[] = []
  for (let day = utcDayStart(period.from); day * 1000 < period.to; day += DAY_SECONDS) {
    days.push(day)
  }
  return days
}

/** First and last day (`YYYY-MM-DD`, inclusive) of a period, for forms and file names. */
export const periodDates = (period: Pick<SlaPeriod, 'from' | 'to'>) => ({
  from: isoDay(period.from),
  to: isoDay(period.to - DAY_MS),
})

/** The period of a target's window that contains `now`. */
export function currentPeriod(window: SlaWindow, now: Date): SlaPeriod {
  const year = now.getUTCFullYear()
  const month = now.getUTCMonth()
  switch (window) {
    case 'month':
      return {
        from: Date.UTC(year, month, 1),
        to: Date.UTC(year, month + 1, 1),
        key: isoDay(Date.UTC(year, month, 1)).slice(0, 7),
      }
    case 'quarter': {
      const first = month - (month % 3)
      return {
        from: Date.UTC(year, first, 1),
        to: Date.UTC(year, first + 3, 1),
        key: `${year}-Q${first / 3 + 1}`,
      }
    }
    case 'rolling30': {
      const end = utcDayStart(now.getTime()) * 1000 + DAY_MS
      return { from: end - 30 * DAY_MS, to: end, key: `rolling30:${isoDay(end - DAY_MS)}` }
    }
  }
}

/**
 * The most recent complete period of a report schedule at `now`: the previous calendar month, or
 * the previous week (Monday to Sunday). Null for unscheduled reports.
 */
export function previousSchedulePeriod(schedule: SlaSchedule, now: Date): SlaPeriod | null {
  if (schedule === 'monthly') {
    const from = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)
    return {
      from,
      to: Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
      key: isoDay(from).slice(0, 7),
    }
  }
  if (schedule === 'weekly') {
    const today = utcDayStart(now.getTime()) * 1000
    const weekday = (new Date(today).getUTCDay() + 6) % 7 // Monday = 0
    const to = today - weekday * DAY_MS
    const from = to - 7 * DAY_MS
    return { from, to, key: `week:${isoDay(from)}` }
  }
  return null
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/**
 * A report range from two `YYYY-MM-DD` dates (both inclusive). Null when a date is invalid, the
 * range is reversed or longer than `SLA_MAX_REPORT_DAYS`.
 */
export function periodFromDates(fromDate: string, toDate: string): SlaPeriod | null {
  if (!DATE_RE.test(fromDate) || !DATE_RE.test(toDate)) return null
  const from = Date.parse(`${fromDate}T00:00:00Z`)
  const last = Date.parse(`${toDate}T00:00:00Z`)
  if (!Number.isFinite(from) || !Number.isFinite(last) || last < from) return null
  // `Date.parse` rolls 2026-02-31 over; reject dates that do not round-trip.
  if (isoDay(from) !== fromDate || isoDay(last) !== toDate) return null
  const to = last + DAY_MS
  if ((to - from) / DAY_MS > SLA_MAX_REPORT_DAYS) return null
  return { from, to, key: `${fromDate}..${toDate}` }
}

// ---- Figures and attainment -------------------------------------------------------------------------

/** What a monitor did during (the elapsed part of) a period. */
export interface SlaFigures {
  /** Successful checks (up, degraded and maintenance beats). */
  up: number
  /** Failed checks (down and pending beats). */
  down: number
  /** Beats recorded during maintenance (also counted in `up`). */
  maintenanceChecks: number
  /** Seconds spent DOWN. */
  downSeconds: number
  /** Seconds whose state is known. */
  knownSeconds: number
  /** Seconds spent in MAINTENANCE (part of `knownSeconds`). */
  maintenanceSeconds: number
  /** Seconds of the days with data (elapsed part of the current day included). */
  elapsedSeconds: number
}

export const emptySlaFigures = (): SlaFigures => ({
  up: 0,
  down: 0,
  maintenanceChecks: 0,
  downSeconds: 0,
  knownSeconds: 0,
  maintenanceSeconds: 0,
  elapsedSeconds: 0,
})

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value))

/** Uptime (0..1) of `figures`, or null when there is nothing to divide by. */
export function slaUptime(
  mode: SlaCalculation,
  figures: SlaFigures,
  excludeMaintenance: boolean,
): number | null {
  if (mode === 'checks') {
    const excluded = excludeMaintenance ? Math.min(figures.maintenanceChecks, figures.up) : 0
    const up = figures.up - excluded
    const total = up + figures.down
    return total > 0 ? clamp01(up / total) : null
  }
  const known = figures.knownSeconds - (excludeMaintenance ? figures.maintenanceSeconds : 0)
  return known > 0 ? clamp01(1 - figures.downSeconds / known) : null
}

export interface SlaTargetSpec {
  /** Percent, e.g. 99.9. */
  target: number
  calculation: SlaCalculation
  excludeMaintenance: boolean
}

export interface SlaAttainment {
  /** 0..1 over the elapsed part of the period; null without data. */
  uptime: number | null
  /** Whether the uptime reaches the target; null without data. */
  met: boolean | null
  /** Downtime the target allows over the whole period, in seconds. */
  budgetSeconds: number
  /** Downtime spent so far, in seconds. */
  consumedSeconds: number
  /** `budgetSeconds - consumedSeconds` (negative once the budget is exhausted). */
  remainingSeconds: number
  /** `remainingSeconds / budgetSeconds` (1 = untouched, 0 = exhausted, below 0 = overspent). */
  remainingRatio: number | null
  /**
   * Error rate relative to the allowed one: 1 spends exactly the budget by the end of the period,
   * 2 spends it in half the period. Null without data.
   */
  burnRate: number | null
}

/**
 * Attainment of `spec` given what happened so far in a period of `totalSeconds`.
 *
 * The budget is `(1 - target) × (period - excluded maintenance)`. The downtime spent is the time
 * DOWN in `duration` mode and the failure ratio applied to the observed time in `checks` mode.
 */
export function slaAttainment(
  spec: SlaTargetSpec,
  figures: SlaFigures,
  totalSeconds: number,
): SlaAttainment {
  const allowed = Math.max(0, 1 - spec.target / 100)
  const excluded = spec.excludeMaintenance ? figures.maintenanceSeconds : 0
  const budgetSeconds = allowed * Math.max(0, totalSeconds - excluded)
  const uptime = slaUptime(spec.calculation, figures, spec.excludeMaintenance)
  const consumedSeconds =
    uptime === null
      ? 0
      : spec.calculation === 'duration'
        ? figures.downSeconds
        : (1 - uptime) * Math.max(0, figures.elapsedSeconds - excluded)
  const remainingSeconds = budgetSeconds - consumedSeconds
  return {
    uptime,
    // A tiny tolerance keeps 99.9 % of a 99.9 % target "met" despite floating point.
    met: uptime === null ? null : uptime >= spec.target / 100 - 1e-12,
    budgetSeconds,
    consumedSeconds,
    remainingSeconds,
    remainingRatio: budgetSeconds > 0 ? remainingSeconds / budgetSeconds : null,
    burnRate: uptime === null || allowed <= 0 ? null : (1 - uptime) / allowed,
  }
}

/** Health of a target for badges: met, at risk (budget burning faster than allowed), missed. */
export type SlaHealth = 'nodata' | 'met' | 'atRisk' | 'missed'

export function slaHealth(attainment: SlaAttainment): SlaHealth {
  if (attainment.uptime === null) return 'nodata'
  // Missed once the period's budget is spent; below the target with budget left (early in a
  // period), or burning faster than allowed, it is at risk.
  if (attainment.remainingSeconds < 0) return 'missed'
  if (attainment.met === false || (attainment.burnRate ?? 0) > 1) return 'atRisk'
  return 'met'
}

// ---- Incidents --------------------------------------------------------------------------------------

export interface SlaIncident {
  startedAt: string
  resolvedAt?: string | null
}

/**
 * Mean time to recovery (seconds) of the incidents that were resolved, or null when none was.
 */
export function meanTimeToRecovery(incidents: readonly SlaIncident[]): number | null {
  const durations = incidents.flatMap((incident) => {
    if (!incident.resolvedAt) return []
    const span = Date.parse(incident.resolvedAt) - Date.parse(incident.startedAt)
    return Number.isFinite(span) && span >= 0 ? [span / 1000] : []
  })
  if (durations.length === 0) return null
  return durations.reduce((sum, value) => sum + value, 0) / durations.length
}

// ---- Report -----------------------------------------------------------------------------------------

/** One line of an SLA report: a target over the report's range. */
export interface SlaReportRow {
  targetId: string
  /** The monitor's name. */
  name: string
  /** Percent. */
  target: number
  calculation: SlaCalculation
  excludeMaintenance: boolean
  /** 0..1, null without data. */
  uptime: number | null
  /** Seconds DOWN within the range, null without data. */
  downtimeSeconds: number | null
  /** Monitor incidents overlapping the range. */
  incidents: number
  /** Mean time to recovery of those incidents (seconds), null when none was resolved. */
  mttrSeconds: number | null
  met: boolean | null
  budgetSeconds: number
  remainingSeconds: number
}

export interface SlaReportData {
  name: string
  /** Inclusive `YYYY-MM-DD` dates. */
  from: string
  to: string
  generatedAt: string
  rows: SlaReportRow[]
}

const fixed = (value: number | null, digits: number): string =>
  value === null ? '' : value.toFixed(digits)

/**
 * The report as CSV:
 * `item,target_percent,uptime_percent,downtime_minutes,incidents,mttr_minutes,target_met,budget_minutes,budget_remaining_minutes`.
 */
export function slaReportCsv(report: SlaReportData): string {
  const lines = [
    'item,target_percent,uptime_percent,downtime_minutes,incidents,mttr_minutes,target_met,budget_minutes,budget_remaining_minutes',
  ]
  for (const row of report.rows) {
    lines.push(
      [
        csvCell(row.name),
        String(row.target),
        fixed(row.uptime === null ? null : row.uptime * 100, 4),
        fixed(row.downtimeSeconds === null ? null : row.downtimeSeconds / 60, 1),
        String(row.incidents),
        fixed(row.mttrSeconds === null ? null : row.mttrSeconds / 60, 1),
        row.met === null ? '' : row.met ? 'yes' : 'no',
        fixed(row.budgetSeconds / 60, 1),
        fixed(row.remainingSeconds / 60, 1),
      ].join(','),
    )
  }
  return `${lines.join('\r\n')}\r\n`
}

/** File name stem of a report export: `<slug>-sla-<from>-<to>`. */
export function slaReportFileStem(report: Pick<SlaReportData, 'name' | 'from' | 'to'>): string {
  const slug =
    report.name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'report'
  return `${slug}-sla-${report.from}-${report.to}`
}
