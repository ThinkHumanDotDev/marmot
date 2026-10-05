/**
 * Maintenance status and window computation.
 *
 * Port of the scheduling semantics of Uptime Kuma 2.x `server/model/maintenance.js`
 * (`getStatus`, `generateCron`, `calcDuration`, `getRunningTimeslot`, `inferDuration`; MIT License,
 * Copyright (c) 2021 Louis Lam, https://github.com/louislam/uptime-kuma). See THIRD_PARTY_NOTICES.md.
 *
 * Unlike Kuma, which keeps an in-memory cron job per maintenance and flips a status flag when it
 * fires, everything here is a pure function of the document and `now`: the worker recomputes
 * statuses every minute and the engine asks on every check. Windows are computed with `croner`
 * (cron patterns in the maintenance's timezone, DST-aware) and `date-fns-tz` (wall-clock dates of
 * the date range and the "every N days" strategy).
 */
import { Cron } from 'croner'
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz'

import {
  isRecurringStrategy,
  SAME_AS_SERVER,
  type MaintenanceStatus,
  type MaintenanceStrategy,
} from '@/lib/validation/maintenance'

export type { MaintenanceStatus, MaintenanceStrategy }

/** The fields the computation reads; `Maintenance` documents and form values both satisfy it. */
export interface MaintenanceLike {
  strategy: MaintenanceStrategy | string
  active?: boolean | null
  /** Wall-clock `YYYY-MM-DDTHH:mm` in the maintenance timezone, or an ISO instant. */
  dateRange?: { start?: string | null; end?: string | null } | null
  /** `HH:mm` wall-clock window of a day (recurring strategies). */
  timeRange?: { start?: string | null; end?: string | null } | null
  intervalDay?: number | null
  /** `0` (Sunday) … `6`. */
  weekdays?: (string | number)[] | null
  /** `1` … `31` and `lastDay1` … `lastDay4`. */
  daysOfMonth?: (string | number)[] | null
  cron?: string | null
  /** Minutes (cron strategy). */
  duration?: number | null
  /** IANA zone or `SAME_AS_SERVER`. */
  timezone?: string | null
}

/** A concrete occurrence, as ISO instants. */
export interface MaintenanceWindow {
  start: string
  end: string
}

export interface MaintenanceTimeslots {
  status: MaintenanceStatus
  /** The IANA zone the windows were computed in. */
  timezone: string
  /** Window containing `now` (status `under-maintenance`). */
  current: MaintenanceWindow | null
  /** First window starting after `now` (or after the date range start while `scheduled`). */
  next: MaintenanceWindow | null
}

export interface ComputeOptions {
  /** Zone used for `SAME_AS_SERVER`; defaults to the process timezone. */
  serverTimezone?: string
}

const MINUTE_MS = 60_000
const DAY_MS = 24 * 60 * MINUTE_MS

export function processTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

/** The IANA zone a maintenance runs in (`SAME_AS_SERVER` → `serverTimezone`). */
export function resolveTimezone(
  timezone: string | null | undefined,
  serverTimezone?: string,
): string {
  if (!timezone || timezone === SAME_AS_SERVER) return serverTimezone || processTimezone()
  return timezone
}

const parseHHmm = (value: string | null | undefined): { hour: number; minute: number } | null => {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value ?? '')
  if (!match) return null
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour > 23 || minute > 59) return null
  return { hour, minute }
}

/**
 * Length of the daily window in minutes (Kuma `calcDuration`): `end - start`, plus 24h when the
 * window crosses midnight.
 */
export function windowDurationMinutes(timeRange: MaintenanceLike['timeRange']): number {
  const start = parseHHmm(timeRange?.start)
  const end = parseHHmm(timeRange?.end)
  if (!start || !end) return 0
  let minutes = end.hour * 60 + end.minute - (start.hour * 60 + start.minute)
  if (minutes < 0) minutes += 24 * 60
  return minutes
}

/** Effective duration of one occurrence in minutes (cron: `duration`; recurring: the time range). */
export function effectiveDurationMinutes(doc: MaintenanceLike): number {
  if (doc.strategy === 'cron') return Math.max(0, doc.duration ?? 0)
  if (isRecurringStrategy(doc.strategy)) return windowDurationMinutes(doc.timeRange)
  return 0
}

/**
 * Cron pattern of a recurring strategy (Kuma `generateCron`). Day-of-month `lastDay1` becomes `L`;
 * `lastDay2`–`lastDay4` have no cron equivalent and are ignored, exactly like Kuma.
 */
export function buildCron(doc: MaintenanceLike): string | null {
  if (doc.strategy === 'cron') return doc.cron?.trim() || null
  const start = parseHHmm(doc.timeRange?.start)
  if (!start) return null
  const time = `${start.minute} ${start.hour}`

  switch (doc.strategy) {
    case 'recurring-interval':
      return `${time} * * *`
    case 'recurring-weekday': {
      const days = [...new Set((doc.weekdays ?? []).map(Number).filter((d) => d >= 0 && d <= 6))]
      if (days.length === 0) return null
      return `${time} * * ${days.sort((a, b) => a - b).join(',')}`
    }
    case 'recurring-day-of-month': {
      const days = new Set<string>()
      for (const raw of doc.daysOfMonth ?? []) {
        const value = String(raw)
        if (value === 'lastDay1') days.add('L')
        else if (/^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= 31) days.add(value)
      }
      if (days.size === 0) return null
      const sorted = [...days].sort((a, b) =>
        a === 'L' ? 1 : b === 'L' ? -1 : Number(a) - Number(b),
      )
      return `${time} ${sorted.join(',')} * *`
    }
    default:
      return null
  }
}

/** Throws when the cron pattern of the document cannot be parsed. */
export function validateCron(pattern: string): void {
  // No callback → nothing is scheduled; the constructor only parses.
  new Cron(pattern, { timezone: 'UTC' })
}

const HAS_OFFSET = /(Z|[+-]\d{2}:?\d{2})$/i

/**
 * A date-range bound as an instant. Wall-clock values (`YYYY-MM-DDTHH:mm`) are read in `timezone`,
 * like Kuma's `dayjs.tz(start_date, timezone)`; values with an explicit offset are taken as-is.
 */
export function parseBound(value: string | null | undefined, timezone: string): Date | null {
  if (!value) return null
  const date = HAS_OFFSET.test(value) ? new Date(value) : fromZonedTime(value, timezone)
  return Number.isNaN(date.getTime()) ? null : date
}

/** Day index (days since the epoch) of the calendar date `instant` falls on in `timezone`. */
const dayIndexIn = (instant: Date, timezone: string): number => {
  const ymd = formatInTimeZone(instant, timezone, 'yyyy-MM-dd')
  return Math.floor(Date.parse(`${ymd}T00:00:00Z`) / DAY_MS)
}

const dateOfDayIndex = (index: number): string => new Date(index * DAY_MS).toISOString().slice(0, 10)

/** `nextStart(after)` → the first occurrence starting strictly after `after`, or null. */
type NextStart = (after: Date) => Date | null

function cronNextStart(pattern: string, timezone: string): NextStart {
  const job = new Cron(pattern, { timezone })
  return (after) => job.nextRun(after)
}

/**
 * "Every N days" occurrences: days `anchor + k·N` (anchor = calendar date of the range start in
 * the maintenance timezone) at the window's start time. Without a start date it is simply daily.
 */
function intervalNextStart(
  doc: MaintenanceLike,
  timezone: string,
  rangeStart: Date | null,
): NextStart {
  const every = Math.max(1, Math.floor(doc.intervalDay ?? 1))
  const time = doc.timeRange?.start ?? '00:00'
  if (!rangeStart || every === 1) {
    const pattern = buildCron({ ...doc, strategy: 'recurring-interval' })
    if (!pattern) return () => null
    return cronNextStart(pattern, timezone)
  }
  const anchor = dayIndexIn(rangeStart, timezone)
  const startOfDay = (index: number) => fromZonedTime(`${dateOfDayIndex(index)}T${time}`, timezone)
  return (after) => {
    const k = Math.ceil((dayIndexIn(after, timezone) - anchor) / every)
    // Zone offsets can move an occurrence across the day index boundary; probe the neighbours.
    for (const candidate of [k - 1, k, k + 1]) {
      const start = startOfDay(anchor + candidate * every)
      if (start.getTime() > after.getTime()) return start
    }
    return null
  }
}

function nextStartFor(doc: MaintenanceLike, timezone: string, rangeStart: Date | null): NextStart {
  if (doc.strategy === 'recurring-interval') return intervalNextStart(doc, timezone, rangeStart)
  const pattern = buildCron(doc)
  if (!pattern) return () => null
  return cronNextStart(pattern, timezone)
}

const toWindow = (start: Date, end: Date): MaintenanceWindow => ({
  start: start.toISOString(),
  end: end.toISOString(),
})

/**
 * Status plus the current and next window of a maintenance at `now` (Kuma `getStatus` +
 * `getRunningTimeslot`, without the in-memory job).
 *
 * - `inactive` when paused; `manual` is always `under-maintenance`
 * - `scheduled` before the date range starts, `ended` after it ends
 * - `single`: `under-maintenance` inside the range
 * - recurring / cron: `under-maintenance` while inside an occurrence (clipped to the range end,
 *   Kuma `inferDuration`), `scheduled` while another occurrence is coming, `ended` when none is,
 *   `unknown` when the pattern cannot be evaluated
 */
export function computeMaintenanceTimeslots(
  doc: MaintenanceLike,
  now: Date = new Date(),
  options: ComputeOptions = {},
): MaintenanceTimeslots {
  const timezone = resolveTimezone(doc.timezone, options.serverTimezone)
  const result = (status: MaintenanceStatus): MaintenanceTimeslots => ({
    status,
    timezone,
    current: null,
    next: null,
  })

  if (doc.active === false) return result('inactive')
  if (doc.strategy === 'manual') return result('under-maintenance')

  const rangeStart = parseBound(doc.dateRange?.start, timezone)
  const rangeEnd = parseBound(doc.dateRange?.end, timezone)
  const nowMs = now.getTime()

  if (doc.strategy === 'single') {
    if (!rangeStart || !rangeEnd) return result('unknown')
    const window = toWindow(rangeStart, rangeEnd)
    if (nowMs < rangeStart.getTime()) return { status: 'scheduled', timezone, current: null, next: window }
    if (nowMs >= rangeEnd.getTime()) return result('ended')
    return { status: 'under-maintenance', timezone, current: window, next: null }
  }

  const durationMs = effectiveDurationMinutes(doc) * MINUTE_MS
  let nextStart: NextStart
  try {
    nextStart = nextStartFor(doc, timezone, rangeStart)
  } catch {
    return result('unknown')
  }

  const occurrenceAfter = (after: Date): MaintenanceWindow | null => {
    const start = nextStart(after)
    if (!start) return null
    if (rangeEnd && start.getTime() >= rangeEnd.getTime()) return null
    const end = new Date(start.getTime() + durationMs)
    return toWindow(start, rangeEnd && end > rangeEnd ? rangeEnd : end)
  }

  if (rangeStart && nowMs < rangeStart.getTime()) {
    // First occurrence at or after the range start.
    const next = occurrenceAfter(new Date(rangeStart.getTime() - 1))
    return { status: 'scheduled', timezone, current: null, next }
  }
  if (rangeEnd && nowMs >= rangeEnd.getTime()) return result('ended')
  if (durationMs <= 0) return result('unknown')

  // The occurrence whose end is still in the future (strictly-after semantics of `nextRun`).
  const candidate = nextStart(new Date(nowMs - durationMs))
  if (
    candidate &&
    candidate.getTime() <= nowMs &&
    (!rangeStart || candidate.getTime() >= rangeStart.getTime())
  ) {
    const end = new Date(candidate.getTime() + durationMs)
    const current = toWindow(candidate, rangeEnd && end > rangeEnd ? rangeEnd : end)
    return { status: 'under-maintenance', timezone, current, next: occurrenceAfter(now) }
  }

  const next = occurrenceAfter(now)
  return { status: next ? 'scheduled' : 'ended', timezone, current: null, next }
}

/** Just the status (see `computeMaintenanceTimeslots`). */
export function getMaintenanceStatus(
  doc: MaintenanceLike,
  now: Date = new Date(),
  options: ComputeOptions = {},
): MaintenanceStatus {
  return computeMaintenanceTimeslots(doc, now, options).status
}

export const isUnderMaintenanceStatus = (status: MaintenanceStatus): boolean =>
  status === 'under-maintenance'
