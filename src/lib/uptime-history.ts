/**
 * Daily uptime of status page components (#112): the maths behind the daily bars, the uptime
 * calculation modes and the preserved monthly history. Pure functions only (no Payload imports), so
 * the server, the worker and the browser share them.
 *
 * A component's day is described by its `DayFigures`, the ingredients of every mode:
 *
 * - `checks` (default): successful checks / all checks (`up / (up + down)`, as in the stat rollups:
 *   degraded and maintenance beats count as up, pending ones as down);
 * - `duration`: time not in a DOWN state / time with a known state, replayed from the important
 *   heartbeats (status transitions);
 * - `manual`: derived from incident impacts only: a major outage counts as down, a partial outage as
 *   half down, degraded performance as up.
 *
 * Days are UTC days, like the `stat-daily` buckets they are read from.
 */
import type { ComponentImpact } from '@/lib/status-page-components'
import type { TimelineUpdate } from '@/lib/incident-timeline'

export const UPTIME_CALCULATION_MODES = ['checks', 'duration', 'manual'] as const
export type UptimeCalculationMode = (typeof UPTIME_CALCULATION_MODES)[number]
export const DEFAULT_UPTIME_CALCULATION_MODE: UptimeCalculationMode = 'checks'

export const isUptimeCalculationMode = (value: unknown): value is UptimeCalculationMode =>
  typeof value === 'string' && (UPTIME_CALCULATION_MODES as readonly string[]).includes(value)

/** Number of daily bars a page can show per component. */
export const UPTIME_BAR_DAY_OPTIONS = [30, 45, 90] as const
export type UptimeBarDays = (typeof UPTIME_BAR_DAY_OPTIONS)[number]
export const DEFAULT_UPTIME_BAR_DAYS: UptimeBarDays = 90

/** The page's bar count, falling back to the default for unknown values. */
export const uptimeBarDaysOf = (value: unknown): UptimeBarDays =>
  (UPTIME_BAR_DAY_OPTIONS as readonly unknown[]).includes(value)
    ? (value as UptimeBarDays)
    : DEFAULT_UPTIME_BAR_DAYS

export const DAY_SECONDS = 86_400
const DAY_MS = DAY_SECONDS * 1000

/** Unix seconds of the start of the UTC day containing `ms`. */
export const utcDayStart = (ms: number): number => Math.floor(ms / DAY_MS) * DAY_SECONDS

/** `YYYY-MM-DD` of a UTC day start (unix seconds). */
export const dayLabel = (day: number): string => new Date(day * 1000).toISOString().slice(0, 10)

/** `YYYY-MM` of a UTC day start (unix seconds). */
export const monthLabel = (day: number): string => dayLabel(day).slice(0, 7)

/**
 * The `count` UTC day starts ending with today's, oldest first.
 */
export function windowDays(count: number, now: Date): number[] {
  const today = utcDayStart(now.getTime())
  return Array.from({ length: count }, (_, i) => today - (count - 1 - i) * DAY_SECONDS)
}

/** Worst state of a day, least to most severe. `nodata`: nothing was recorded that day. */
export const DAY_STATES = ['nodata', 'up', 'maintenance', 'degraded', 'partial', 'down'] as const
export type DayState = (typeof DAY_STATES)[number]

export const worstDayState = (states: readonly DayState[]): DayState =>
  states.reduce<DayState>(
    (worst, state) => (DAY_STATES.indexOf(state) > DAY_STATES.indexOf(worst) ? state : worst),
    'nodata',
  )

/** What one component did during one day (or the sum over several days). */
export interface DayFigures {
  /** Successful checks (up, degraded and maintenance beats). */
  up: number
  /** Failed checks (down and pending beats). */
  down: number
  /** Seconds spent in a DOWN state (duration mode). */
  downSeconds: number
  /** Seconds whose state is known (duration mode denominator). */
  knownSeconds: number
  /** Incident downtime weighted by impact (manual mode): major outage 1, partial outage 0.5. */
  impactSeconds: number
  /** Seconds of the day covered: the whole day, or the elapsed part of today. */
  elapsedSeconds: number
}

export const emptyFigures = (): DayFigures => ({
  up: 0,
  down: 0,
  downSeconds: 0,
  knownSeconds: 0,
  impactSeconds: 0,
  elapsedSeconds: 0,
})

export function sumFigures(list: readonly DayFigures[]): DayFigures {
  const total = emptyFigures()
  for (const figures of list) {
    total.up += figures.up
    total.down += figures.down
    total.downSeconds += figures.downSeconds
    total.knownSeconds += figures.knownSeconds
    total.impactSeconds += figures.impactSeconds
    total.elapsedSeconds += figures.elapsedSeconds
  }
  return total
}

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value))

/** Uptime (0..1) of `figures` under `mode`, or null when the mode has nothing to divide by. */
export function uptimeOf(mode: UptimeCalculationMode, figures: DayFigures): number | null {
  switch (mode) {
    case 'checks': {
      const total = figures.up + figures.down
      return total > 0 ? clamp01(figures.up / total) : null
    }
    case 'duration':
      return figures.knownSeconds > 0
        ? clamp01(1 - figures.downSeconds / figures.knownSeconds)
        : null
    case 'manual':
      return figures.elapsedSeconds > 0
        ? clamp01(1 - figures.impactSeconds / figures.elapsedSeconds)
        : null
  }
}

/**
 * Downtime (seconds) shown for `figures`: incident downtime in manual mode, time spent DOWN
 * otherwise; null when the state was never known.
 */
export function downtimeOf(mode: UptimeCalculationMode, figures: DayFigures): number | null {
  if (mode === 'manual') return figures.elapsedSeconds > 0 ? figures.impactSeconds : null
  return figures.knownSeconds > 0 ? figures.downSeconds : null
}

// ---- Duration mode: replaying status transitions ---------------------------------------------------

export type BeatStatus = 'up' | 'down' | 'pending' | 'maintenance' | 'degraded'

export interface StatusChange {
  /** Epoch milliseconds. */
  time: number
  status: BeatStatus
}

export interface StatusReplay {
  downSeconds: number
  knownSeconds: number
  /** Seconds spent in MAINTENANCE (SLA targets may exclude them, #156). */
  maintenanceSeconds: number
  /** Statuses held at some point of the interval. */
  held: Set<BeatStatus>
}

/**
 * Time spent DOWN within `[from, to)` (epoch ms), given the status at `from` (`null` = unknown, the
 * time before the first change is then left out) and the changes inside the interval, oldest first.
 */
export function replayStatuses(
  initial: BeatStatus | null,
  changes: readonly StatusChange[],
  from: number,
  to: number,
): StatusReplay {
  const held = new Set<BeatStatus>()
  let downMs = 0
  let knownMs = 0
  let maintenanceMs = 0
  let status = initial
  let cursor = from
  const close = (until: number) => {
    const span = Math.max(0, Math.min(until, to) - cursor)
    if (status === null || span <= 0) return
    knownMs += span
    if (status === 'down') downMs += span
    if (status === 'maintenance') maintenanceMs += span
    held.add(status)
  }
  for (const change of changes) {
    if (change.time < from) {
      status = change.status
      continue
    }
    if (change.time >= to) break
    close(change.time)
    cursor = change.time
    status = change.status
  }
  if (cursor < to) close(to)
  return {
    downSeconds: downMs / 1000,
    knownSeconds: knownMs / 1000,
    maintenanceSeconds: maintenanceMs / 1000,
    held,
  }
}

// ---- Manual mode: incident impacts ------------------------------------------------------------------

/** Share of a second that counts as down per impact in manual mode. */
export const IMPACT_DOWN_WEIGHT: Record<ComponentImpact, number> = {
  operational: 0,
  degraded_performance: 0,
  partial_outage: 0.5,
  major_outage: 1,
}

const IMPACT_RANK: Record<ComponentImpact, number> = {
  operational: 0,
  degraded_performance: 1,
  partial_outage: 2,
  major_outage: 3,
}

/** A stretch of time during which an incident set a component's impact. */
export interface ImpactSpan {
  /** Epoch milliseconds. */
  start: number
  /** Epoch milliseconds; null while the impact still holds. */
  end: number | null
  impact: ComponentImpact
}

/**
 * The spans in which an incident's updates (oldest first) gave `componentId` a non-operational
 * impact: an update naming the component sets its impact, a `resolved` update resets it.
 */
export function componentImpactSpans(
  updates: readonly Pick<TimelineUpdate, 'status' | 'postedAt' | 'components'>[],
  componentId: string,
): ImpactSpan[] {
  const spans: ImpactSpan[] = []
  let current: ComponentImpact = 'operational'
  let since = 0
  for (const update of updates) {
    const time = Date.parse(update.postedAt)
    if (!Number.isFinite(time)) continue
    let next: ComponentImpact = current
    for (const row of update.components ?? []) {
      if (String(row.component) === componentId) next = row.impact
    }
    if (update.status === 'resolved') next = 'operational'
    if (next === current) continue
    if (current !== 'operational') spans.push({ start: since, end: time, impact: current })
    current = next
    since = time
  }
  if (current !== 'operational') spans.push({ start: since, end: null, impact: current })
  return spans
}

/**
 * Incident downtime within `[from, to)` (epoch ms): at every instant the worst impact of the
 * overlapping spans counts (overlapping incidents are not added up). Also returns the worst impact
 * seen in the interval.
 */
export function impactWithin(
  spans: readonly ImpactSpan[],
  from: number,
  to: number,
): { impactSeconds: number; worst: ComponentImpact | null } {
  const overlapping = spans
    .map((span) => ({
      start: Math.max(span.start, from),
      end: Math.min(span.end ?? to, to),
      impact: span.impact,
    }))
    .filter((span) => span.end > span.start)
  if (overlapping.length === 0) return { impactSeconds: 0, worst: null }

  let worst: ComponentImpact | null = null
  for (const span of overlapping) {
    if (worst === null || IMPACT_RANK[span.impact] > IMPACT_RANK[worst]) worst = span.impact
  }

  const edges = [...new Set(overlapping.flatMap((span) => [span.start, span.end]))].sort(
    (a, b) => a - b,
  )
  let weightedMs = 0
  for (let i = 0; i < edges.length - 1; i++) {
    const [start, end] = [edges[i], edges[i + 1]]
    let weight = 0
    for (const span of overlapping) {
      if (span.start <= start && span.end >= end) {
        weight = Math.max(weight, IMPACT_DOWN_WEIGHT[span.impact])
      }
    }
    weightedMs += weight * (end - start)
  }
  return { impactSeconds: weightedMs / 1000, worst }
}

// ---- Day state --------------------------------------------------------------------------------------

/**
 * Colour of a day's bar: its worst state. DOWN beats and major outages are `down`, partial outages
 * `partial`, degraded checks or degraded performance `degraded`, maintenance `maintenance`.
 */
export function dayState(input: {
  hasData: boolean
  held?: Iterable<BeatStatus>
  degradedChecks?: number
  impact?: ComponentImpact | null
}): DayState {
  const held = new Set(input.held ?? [])
  const states: DayState[] = [input.hasData ? 'up' : 'nodata']
  if (held.has('down') || input.impact === 'major_outage') states.push('down')
  if (input.impact === 'partial_outage') states.push('partial')
  if (
    held.has('degraded') ||
    (input.degradedChecks ?? 0) > 0 ||
    input.impact === 'degraded_performance'
  ) {
    states.push('degraded')
  }
  if (held.has('maintenance')) states.push('maintenance')
  return worstDayState(states)
}

// ---- History export ---------------------------------------------------------------------------------

export interface MonthlyUptimeRow {
  /** `YYYY-MM`. */
  month: string
  componentId: string
  component: string
  /** 0..1, null without data. */
  uptime: number | null
  /** Downtime in seconds (see `downtimeOf`), null without data. */
  downtimeSeconds: number | null
  /** Days of the month with data. */
  days: number
}

/** One CSV cell: quoted when needed, formula-looking values neutralised (CSV injection). */
export const csvCell = (value: string): string =>
  /[",\n\r]/.test(value) || /^[=+\-@\t\r]/.test(value)
    ? `"${(/^[=+\-@\t\r]/.test(value) ? `'${value}` : value).replace(/"/g, '""')}"`
    : value

/** Monthly history as CSV: `month,component_id,component,uptime_percent,downtime_seconds,days`. */
export function monthlyHistoryCsv(rows: readonly MonthlyUptimeRow[]): string {
  const lines = ['month,component_id,component,uptime_percent,downtime_seconds,days']
  for (const row of rows) {
    lines.push(
      [
        row.month,
        csvCell(row.componentId),
        csvCell(row.component),
        row.uptime === null ? '' : (row.uptime * 100).toFixed(4),
        row.downtimeSeconds === null ? '' : String(Math.round(row.downtimeSeconds)),
        String(row.days),
      ].join(','),
    )
  }
  return `${lines.join('\r\n')}\r\n`
}
