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
 * Periods are calendar days, weeks and months of the organization's time zone (#274), and a target
 * may count only the hours of a business-hours calendar. Both turn into a list of counted
 * intervals (`countedIntervals`): the budget is computed on their length, and only what happened
 * inside them counts (see `src/server/sla/compute.ts` for how the figures are read).
 */
import { formatInTimeZone } from 'date-fns-tz'

import { zonedInstant } from '@/lib/on-call'
import { csvCell, DAY_SECONDS } from '@/lib/uptime-history'

export const SLA_WINDOWS = ['month', 'quarter', 'rolling30'] as const
export type SlaWindow = (typeof SLA_WINDOWS)[number]

/**
 * `duration` and `checks` as for monitors; `manual` (status page components and groups only,
 * #274): downtime from the incident impacts of the page, as in the #112 `manual` mode. Static
 * components always use it.
 */
export const SLA_CALCULATIONS = ['duration', 'checks', 'manual'] as const
export type SlaCalculation = (typeof SLA_CALCULATIONS)[number]

/** What a target measures (#274): a monitor, a status page component or a status page group. */
export const SLA_SUBJECTS = ['monitor', 'component', 'group'] as const
export type SlaSubject = (typeof SLA_SUBJECTS)[number]

export const isSlaSubject = (value: unknown): value is SlaSubject =>
  typeof value === 'string' && (SLA_SUBJECTS as readonly string[]).includes(value)

/** Most error budget alert thresholds per target. */
export const SLA_MAX_ALERT_THRESHOLDS = 5

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

/** Where periods are cut: the organization's time zone and first day of the week (#274). */
export interface SlaZone {
  /** IANA zone (`Europe/Berlin`). */
  timeZone: string
  weekStart: 'monday' | 'sunday'
}

export const UTC_ZONE: SlaZone = { timeZone: 'UTC', weekStart: 'monday' }

/** A half-open range of whole local days, `[from, to)` in epoch milliseconds. */
export interface SlaPeriod {
  from: number
  to: number
  /** Stable identifier (`2026-09`, `2026-Q3`, `week:2026-09-28`, `2026-09-01..2026-09-30`). */
  key: string
}

const isoDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10)

/** The local calendar date (`YYYY-MM-DD`) of an instant in a zone. */
export const localDate = (ms: number, timeZone: string): string =>
  timeZone === 'UTC' ? isoDay(ms) : formatInTimeZone(ms, timeZone, 'yyyy-MM-dd')

/** A wall-clock time of a calendar date in a zone (`HH:MM`), as an instant. */
const wallClock = (date: string, time: string, timeZone: string): number =>
  timeZone === 'UTC'
    ? Date.parse(`${date}T${time}:00Z`)
    : zonedInstant(date, time, timeZone).getTime()

/** Local midnight of a calendar date (the first instant of the day where midnight is skipped). */
const midnight = (date: string, timeZone: string): number => wallClock(date, '00:00', timeZone)

/** A calendar date `days` later (negative: earlier). */
const addDays = (date: string, days: number): string =>
  isoDay(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS)

/** First day of the month `months` after the month of `date`. */
const addMonths = (date: string, months: number): string => {
  const [year, month] = date.split('-').map(Number)
  return isoDay(Date.UTC(year, month - 1 + months, 1))
}

/** 0 = Monday … 6 = Sunday. */
const isoWeekday = (date: string): number => (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7

const localRange = (first: string, next: string, timeZone: string) => ({
  from: midnight(first, timeZone),
  to: midnight(next, timeZone),
})

/** Seconds covered by a period. */
export const periodSeconds = (period: Pick<SlaPeriod, 'from' | 'to'>): number =>
  Math.max(0, (period.to - period.from) / 1000)

/** First and last local day (`YYYY-MM-DD`, inclusive) of a period, for forms and file names. */
export const periodDates = (
  period: Pick<SlaPeriod, 'from' | 'to'>,
  zone: Pick<SlaZone, 'timeZone'> = UTC_ZONE,
) => ({
  from: localDate(period.from, zone.timeZone),
  to: localDate(period.to - 1, zone.timeZone),
})

/** The period of a target's window that contains `now`, in calendar days of the zone. */
export function currentPeriod(
  window: SlaWindow,
  now: Date,
  zone: Pick<SlaZone, 'timeZone'> = UTC_ZONE,
): SlaPeriod {
  const today = localDate(now.getTime(), zone.timeZone)
  const month = `${today.slice(0, 8)}01`
  switch (window) {
    case 'month':
      return { ...localRange(month, addMonths(month, 1), zone.timeZone), key: month.slice(0, 7) }
    case 'quarter': {
      const monthIndex = Number(month.slice(5, 7)) - 1
      const first = addMonths(month, -(monthIndex % 3))
      return {
        ...localRange(first, addMonths(first, 3), zone.timeZone),
        key: `${month.slice(0, 4)}-Q${Math.floor(monthIndex / 3) + 1}`,
      }
    }
    case 'rolling30':
      return {
        ...localRange(addDays(today, -29), addDays(today, 1), zone.timeZone),
        key: `rolling30:${today}`,
      }
  }
}

/**
 * The most recent complete period of a report schedule at `now`: the previous calendar month, or
 * the previous week (starting on the zone's first day of the week). Null for unscheduled reports.
 */
export function previousSchedulePeriod(
  schedule: SlaSchedule,
  now: Date,
  zone: SlaZone = UTC_ZONE,
): SlaPeriod | null {
  const today = localDate(now.getTime(), zone.timeZone)
  if (schedule === 'monthly') {
    const month = `${today.slice(0, 8)}01`
    const first = addMonths(month, -1)
    return { ...localRange(first, month, zone.timeZone), key: first.slice(0, 7) }
  }
  if (schedule === 'weekly') {
    const offset = (isoWeekday(today) + (zone.weekStart === 'sunday' ? 1 : 0)) % 7
    const next = addDays(today, -offset)
    const first = addDays(next, -7)
    return { ...localRange(first, next, zone.timeZone), key: `week:${first}` }
  }
  return null
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** A valid `YYYY-MM-DD` calendar date. */
export const isCalendarDate = (value: unknown): value is string =>
  typeof value === 'string' &&
  DATE_RE.test(value) &&
  // `Date.parse` rolls 2026-02-31 over; reject dates that do not round-trip.
  isoDay(Date.parse(`${value}T00:00:00Z`)) === value

/**
 * A report range from two `YYYY-MM-DD` dates (both inclusive, local days of the zone). Null when a
 * date is invalid, the range is reversed or longer than `SLA_MAX_REPORT_DAYS`.
 */
export function periodFromDates(
  fromDate: string,
  toDate: string,
  zone: Pick<SlaZone, 'timeZone'> = UTC_ZONE,
): SlaPeriod | null {
  if (!isCalendarDate(fromDate) || !isCalendarDate(toDate) || toDate < fromDate) return null
  const days = (Date.parse(`${toDate}T00:00:00Z`) - Date.parse(`${fromDate}T00:00:00Z`)) / DAY_MS
  if (days + 1 > SLA_MAX_REPORT_DAYS) return null
  return {
    ...localRange(fromDate, addDays(toDate, 1), zone.timeZone),
    key: `${fromDate}..${toDate}`,
  }
}

// ---- Counted time: intervals and business hours -----------------------------------------------------

/** A half-open stretch of time, `[from, to)` in epoch milliseconds. */
export interface TimeInterval {
  from: number
  to: number
}

/** Total seconds of disjoint intervals. */
export const intervalsSeconds = (intervals: readonly TimeInterval[]): number =>
  intervals.reduce((sum, { from, to }) => sum + Math.max(0, to - from), 0) / 1000

/** The parts of sorted, disjoint intervals that fall within `[from, to)`. */
export function clipIntervals(
  intervals: readonly TimeInterval[],
  from: number,
  to: number,
): TimeInterval[] {
  const out: TimeInterval[] = []
  for (const interval of intervals) {
    const start = Math.max(interval.from, from)
    const end = Math.min(interval.to, to)
    if (end > start) out.push({ from: start, to: end })
  }
  return out
}

/** Milliseconds of disjoint intervals within `[from, to)`. */
export const overlapMs = (intervals: readonly TimeInterval[], from: number, to: number): number =>
  clipIntervals(intervals, from, to).reduce((sum, i) => sum + (i.to - i.from), 0)

export const SLA_WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const
export type SlaWeekday = (typeof SLA_WEEKDAYS)[number]

/** Most holidays a business-hours calendar lists. */
export const SLA_MAX_HOLIDAYS = 100

/**
 * A business-hours calendar (#274): the weekdays and the wall-clock hours (in the organization's
 * time zone) during which a target counts, minus holidays.
 */
export interface SlaBusinessHours {
  days: SlaWeekday[]
  /** `HH:MM`. */
  start: string
  /** `HH:MM` after `start`, or `24:00`. */
  end: string
  /** `YYYY-MM-DD` local dates that do not count. */
  holidays: string[]
}

const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/

export const isBusinessStart = (value: unknown): value is string =>
  typeof value === 'string' && HHMM_RE.test(value)

export const isBusinessEnd = (value: unknown): value is string =>
  value === '24:00' || isBusinessStart(value)

export const isSlaWeekday = (value: unknown): value is SlaWeekday =>
  typeof value === 'string' && (SLA_WEEKDAYS as readonly string[]).includes(value)

/** Whether a calendar is usable: at least one day, `start` before `end`, valid holidays. */
export const isValidBusinessHours = (hours: SlaBusinessHours): boolean =>
  hours.days.length > 0 &&
  hours.days.every(isSlaWeekday) &&
  isBusinessStart(hours.start) &&
  isBusinessEnd(hours.end) &&
  hours.start < hours.end &&
  hours.holidays.length <= SLA_MAX_HOLIDAYS &&
  hours.holidays.every(isCalendarDate)

/** A stored calendar (`sla-targets.businessHours`): null when it is off or unusable. */
export function businessHoursOf(doc: {
  businessHours?: {
    enabled?: boolean | null
    days?: readonly (string | null)[] | null
    start?: string | null
    end?: string | null
    holidays?: readonly { date?: string | null }[] | null
  } | null
}): SlaBusinessHours | null {
  const stored = doc.businessHours
  if (!stored?.enabled) return null
  const hours: SlaBusinessHours = {
    days: (stored.days ?? []).filter(isSlaWeekday),
    start: stored.start ?? '',
    end: stored.end ?? '',
    holidays: (stored.holidays ?? []).map((row) => row?.date ?? ''),
  }
  return isValidBusinessHours(hours) ? hours : null
}

/** The business hours within a period, oldest first. */
export function businessIntervals(
  period: Pick<SlaPeriod, 'from' | 'to'>,
  hours: SlaBusinessHours,
  timeZone: string,
): TimeInterval[] {
  const days = new Set(hours.days)
  const holidays = new Set(hours.holidays)
  const last = localDate(period.to - 1, timeZone)
  const out: TimeInterval[] = []
  for (let date = localDate(period.from, timeZone); date <= last; date = addDays(date, 1)) {
    if (!days.has(SLA_WEEKDAYS[isoWeekday(date)]) || holidays.has(date)) continue
    const from = wallClock(date, hours.start, timeZone)
    const to =
      hours.end === '24:00'
        ? midnight(addDays(date, 1), timeZone)
        : wallClock(date, hours.end, timeZone)
    out.push(...clipIntervals([{ from, to }], period.from, period.to))
  }
  return out
}

/**
 * The time a target counts within a period: the whole period, or its business hours when the
 * target has a calendar.
 */
export const countedIntervals = (
  period: Pick<SlaPeriod, 'from' | 'to'>,
  hours: SlaBusinessHours | null,
  timeZone: string,
): TimeInterval[] =>
  hours ? businessIntervals(period, hours, timeZone) : [{ from: period.from, to: period.to }]

// ---- Figures and attainment -------------------------------------------------------------------------

/** What a monitor did during the counted, elapsed part of a period. */
export interface SlaFigures {
  /**
   * Successful checks (up, degraded and maintenance beats). Counts are read from hourly or daily
   * buckets and weighted by the share of the bucket that counts, so they may be fractional.
   */
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
  /** Counted seconds of the days with data (elapsed part of the current day included). */
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
      : spec.calculation === 'checks'
        ? (1 - uptime) * Math.max(0, figures.elapsedSeconds - excluded)
        : figures.downSeconds
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

// ---- Error budget alerts ----------------------------------------------------------------------------

/**
 * Remaining budget thresholds (percent) a target alerts on, deduplicated, highest first. Values
 * outside 0..100 are dropped.
 */
export function normalizeThresholds(values: readonly unknown[] | null | undefined): number[] {
  const out = new Set<number>()
  for (const value of values ?? []) {
    const number = typeof value === 'number' ? value : Number(value)
    if (Number.isFinite(number) && number >= 0 && number <= 100) out.add(number)
  }
  return [...out].sort((a, b) => b - a).slice(0, SLA_MAX_ALERT_THRESHOLDS)
}

/** What a target has already alerted on (`sla-targets.budgetAlertState`). */
export interface BudgetAlertState {
  /** `SlaPeriod.key` the thresholds below belong to. */
  period: string
  /** Thresholds already alerted on in that period. */
  sent: number[]
}

export const isBudgetAlertState = (value: unknown): value is BudgetAlertState =>
  !!value &&
  typeof value === 'object' &&
  typeof (value as BudgetAlertState).period === 'string' &&
  Array.isArray((value as BudgetAlertState).sent)

/**
 * The thresholds a target newly crossed: its remaining budget (`remainingRatio`, 1 = untouched)
 * dropped below `threshold` % and no alert went out for that threshold in this period. A new
 * period starts with none sent, so each threshold alerts at most once per period.
 */
export function dueBudgetAlerts(
  thresholds: readonly number[],
  remainingRatio: number | null,
  periodKey: string,
  state: BudgetAlertState | null,
): { due: number[]; state: BudgetAlertState } {
  const sent = state && state.period === periodKey ? state.sent : []
  if (remainingRatio === null) return { due: [], state: { period: periodKey, sent } }
  const remaining = remainingRatio * 100
  const due = thresholds.filter((threshold) => remaining < threshold && !sent.includes(threshold))
  return { due, state: { period: periodKey, sent: [...sent, ...due].sort((a, b) => b - a) } }
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
  /** Only the hours of a business-hours calendar count (#274). */
  businessHours: boolean
  /** 0..1, null without data. */
  uptime: number | null
  /** Seconds DOWN within the range (counted hours only), null without data. */
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
  /** Inclusive `YYYY-MM-DD` dates, local days of `timeZone`. */
  from: string
  to: string
  /** The organization's time zone the days (and business hours) are read in (#274). */
  timeZone: string
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
