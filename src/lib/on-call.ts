/**
 * On-call schedules and escalation policies (#145): the shared vocabulary and the pure rotation
 * maths. Nothing here touches the database, so the dashboard, the route handlers and the
 * escalation worker compute "who is on call" the same way, and the DST behaviour is unit-tested
 * (`on-call.test.ts`).
 *
 * A schedule has layers. Each layer rotates through its members: a shift lasts one day (`daily`),
 * seven days (`weekly`) or a custom number of days or hours, and hands off at `handoffTime`
 * wall-clock time in the layer's time zone (the schedule's when the layer has none). Day-based
 * shifts follow the calendar, so a weekly 09:00 handoff stays at 09:00 local time across DST
 * changes; hour-based shifts are exact durations. Restrictions limit a layer to windows of the
 * week (e.g. weekdays 09:00–17:00); outside them the layer has nobody on call. Later layers take
 * precedence over earlier ones wherever they have somebody on call, and overrides take precedence
 * over every layer (the last matching override wins).
 */
import { formatInTimeZone, fromZonedTime, getTimezoneOffset } from 'date-fns-tz'

export type OnCallId = string | number

export const ROTATION_TYPES = ['daily', 'weekly', 'custom'] as const
export type RotationType = (typeof ROTATION_TYPES)[number]

export const ROTATION_UNITS = ['hours', 'days'] as const
export type RotationUnit = (typeof ROTATION_UNITS)[number]

/** ISO weekday order (Monday first). */
export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const
export type Weekday = (typeof WEEKDAYS)[number]

/** Who an escalation step pages. Phone calls (#146) arrive as a notification channel type. */
export const ESCALATION_TARGET_TYPES = ['schedule', 'user', 'channel'] as const
export type EscalationTargetType = (typeof ESCALATION_TARGET_TYPES)[number]

/** State of a monitor incident's escalation. */
export const ESCALATION_STATUSES = ['active', 'stopped', 'exhausted'] as const
export type EscalationStatus = (typeof ESCALATION_STATUSES)[number]

export const MAX_ESCALATION_REPEATS = 9

export interface LayerRestriction {
  days: readonly Weekday[]
  /** `HH:mm`, inclusive. */
  start: string
  /** `HH:mm`, exclusive; `24:00` for midnight; at or before `start` wraps past midnight. */
  end: string
}

export interface RotationLayer {
  name?: string | null
  /** IANA zone; the schedule's when empty. */
  timezone?: string | null
  rotation: RotationType
  customLength?: number | null
  customUnit?: RotationUnit | null
  /** `HH:mm` wall-clock time of each handoff. */
  handoffTime: string
  /** `YYYY-MM-DD`: the first shift starts on this day at `handoffTime`. */
  startDate: string
  /** Member ids in rotation order. */
  members: readonly OnCallId[]
  restrictions?: readonly LayerRestriction[] | null
}

export interface ScheduleOverride {
  user: OnCallId
  start: string | Date
  end: string | Date
}

export interface ScheduleDefinition {
  timezone: string
  layers: readonly RotationLayer[]
  overrides?: readonly ScheduleOverride[] | null
}

export interface OnCallResult {
  userId: string
  source: 'override' | 'layer'
  /** Index of the layer (or of the override) that put the user on call. */
  index: number
}

export interface OnCallShift {
  userId: string
  source: 'override' | 'layer'
  start: Date
  end: Date
}

const DAY_MS = 86_400_000
const HOUR_MS = 3_600_000

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/
const YMD = /^(\d{4})-(\d{2})-(\d{2})$/

export const isHandoffTime = (value: string): boolean => HHMM.test(value)
export const isRestrictionEnd = (value: string): boolean => value === '24:00' || HHMM.test(value)

export function isValidDateOnly(value: string): boolean {
  const match = YMD.exec(value)
  if (!match) return false
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
  return date.toISOString().slice(0, 10) === value
}

export function isValidTimeZone(value: string | null | undefined): boolean {
  if (!value) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value })
    return true
  } catch {
    return false
  }
}

const minutesOf = (hhmm: string): number => {
  const [h, m] = hhmm.split(':').map(Number)
  return h * 60 + m
}

/** Days since the epoch of a `YYYY-MM-DD` calendar date. */
const dayNumber = (ymd: string): number => {
  const [y, m, d] = ymd.split('-').map(Number)
  return Math.floor(Date.UTC(y, m - 1, d) / DAY_MS)
}

const ymdOf = (day: number): string => new Date(day * DAY_MS).toISOString().slice(0, 10)

/**
 * The instant of a wall-clock time in a zone. A time skipped by a DST change (02:30 on the spring
 * forward night) resolves to the same offset as before the change, i.e. one hour later.
 */
export function zonedInstant(ymd: string, hhmm: string, timeZone: string): Date {
  const candidate = fromZonedTime(`${ymd}T${hhmm}:00`, timeZone)
  if (formatInTimeZone(candidate, timeZone, "yyyy-MM-dd'T'HH:mm") === `${ymd}T${hhmm}`) {
    return candidate
  }
  // Skipped wall-clock time: apply the offset in force before the change.
  const [y, mo, d] = ymd.split('-').map(Number)
  const [h, mi] = hhmm.split(':').map(Number)
  const before = getTimezoneOffset(timeZone, new Date(candidate.getTime() - 6 * HOUR_MS))
  return new Date(Date.UTC(y, mo - 1, d, h, mi) - before)
}

const localYmd = (at: Date, timeZone: string): string =>
  formatInTimeZone(at, timeZone, 'yyyy-MM-dd')

const layerZone = (layer: RotationLayer, schedule: ScheduleDefinition): string =>
  layer.timezone && isValidTimeZone(layer.timezone) ? layer.timezone : schedule.timezone

/** Shift length of a layer: `{ days }` (calendar) or `{ hours }` (exact). */
function shiftLength(layer: RotationLayer): { days: number } | { hours: number } {
  if (layer.rotation === 'daily') return { days: 1 }
  if (layer.rotation === 'weekly') return { days: 7 }
  const length = Math.max(1, Math.floor(layer.customLength ?? 1))
  return layer.customUnit === 'hours' ? { hours: length } : { days: length }
}

/** Start of shift `k` of a layer (k may be any integer). */
export function shiftStart(layer: RotationLayer, timeZone: string, k: number): Date {
  const length = shiftLength(layer)
  if ('hours' in length) {
    return new Date(
      zonedInstant(layer.startDate, layer.handoffTime, timeZone).getTime() +
        k * length.hours * HOUR_MS,
    )
  }
  return zonedInstant(
    ymdOf(dayNumber(layer.startDate) + k * length.days),
    layer.handoffTime,
    timeZone,
  )
}

/** Index of the shift running at `at` (negative before the rotation starts). */
export function shiftIndexAt(layer: RotationLayer, timeZone: string, at: Date): number {
  const length = shiftLength(layer)
  if ('hours' in length) {
    const origin = zonedInstant(layer.startDate, layer.handoffTime, timeZone).getTime()
    return Math.floor((at.getTime() - origin) / (length.hours * HOUR_MS))
  }
  const days = dayNumber(localYmd(at, timeZone)) - dayNumber(layer.startDate)
  let k = Math.floor(days / length.days)
  if (at.getTime() < shiftStart(layer, timeZone, k).getTime()) k -= 1
  else if (at.getTime() >= shiftStart(layer, timeZone, k + 1).getTime()) k += 1
  return k
}

const ISO_WEEKDAY: Record<string, Weekday> = {
  '1': 'mon',
  '2': 'tue',
  '3': 'wed',
  '4': 'thu',
  '5': 'fri',
  '6': 'sat',
  '7': 'sun',
}

const previousWeekday = (day: Weekday): Weekday => WEEKDAYS[(WEEKDAYS.indexOf(day) + 6) % 7]

/** Is `at` inside one of the layer's restriction windows (always, without restrictions)? */
export function withinRestrictions(
  restrictions: readonly LayerRestriction[] | null | undefined,
  timeZone: string,
  at: Date,
): boolean {
  if (!restrictions || restrictions.length === 0) return true
  const weekday = ISO_WEEKDAY[formatInTimeZone(at, timeZone, 'i')]
  const minute = minutesOf(formatInTimeZone(at, timeZone, 'HH:mm'))
  return restrictions.some((window) => {
    const start = minutesOf(window.start)
    const end = window.end === '24:00' ? 24 * 60 : minutesOf(window.end)
    if (end > start) return window.days.includes(weekday) && minute >= start && minute < end
    // Wraps past midnight: the evening of a listed day, or the early morning after one.
    return (
      (window.days.includes(weekday) && minute >= start) ||
      (window.days.includes(previousWeekday(weekday)) && minute < end)
    )
  })
}

/** The member a layer has on call at `at`, or `null`. */
export function layerOnCallAt(
  layer: RotationLayer,
  schedule: ScheduleDefinition,
  at: Date,
): string | null {
  if (layer.members.length === 0) return null
  const timeZone = layerZone(layer, schedule)
  const k = shiftIndexAt(layer, timeZone, at)
  if (k < 0) return null
  if (!withinRestrictions(layer.restrictions, timeZone, at)) return null
  return String(layer.members[k % layer.members.length])
}

const instant = (value: string | Date): number =>
  value instanceof Date ? value.getTime() : Date.parse(value)

/** Who is on call at `at`: the last matching override, else the last layer with somebody. */
export function onCallAt(schedule: ScheduleDefinition, at: Date): OnCallResult | null {
  const time = at.getTime()
  const overrides = schedule.overrides ?? []
  for (let i = overrides.length - 1; i >= 0; i--) {
    const override = overrides[i]
    if (instant(override.start) <= time && time < instant(override.end)) {
      return { userId: String(override.user), source: 'override', index: i }
    }
  }
  for (let i = schedule.layers.length - 1; i >= 0; i--) {
    const userId = layerOnCallAt(schedule.layers[i], schedule, at)
    if (userId !== null) return { userId, source: 'layer', index: i }
  }
  return null
}

/** Instants in `(from, to)` at which the answer of `onCallAt` may change. */
function changePoints(schedule: ScheduleDefinition, from: Date, to: Date): number[] {
  const points = new Set<number>()
  const lo = from.getTime()
  const hi = to.getTime()
  const add = (value: number) => {
    if (value > lo && value < hi) points.add(value)
  }
  for (const override of schedule.overrides ?? []) {
    add(instant(override.start))
    add(instant(override.end))
  }
  for (const layer of schedule.layers) {
    const timeZone = layerZone(layer, schedule)
    const first = Math.max(0, shiftIndexAt(layer, timeZone, from))
    const last = shiftIndexAt(layer, timeZone, to)
    for (let k = first; k <= last + 1 && k - first < 5_000; k++) {
      add(shiftStart(layer, timeZone, k).getTime())
    }
    if (layer.restrictions?.length) {
      const firstDay = dayNumber(localYmd(from, timeZone)) - 1
      const lastDay = dayNumber(localYmd(to, timeZone)) + 1
      for (let day = firstDay; day <= lastDay; day++) {
        for (const window of layer.restrictions) {
          add(zonedInstant(ymdOf(day), window.start, timeZone).getTime())
          add(
            window.end === '24:00'
              ? zonedInstant(ymdOf(day + 1), '00:00', timeZone).getTime()
              : zonedInstant(ymdOf(day), window.end, timeZone).getTime(),
          )
        }
      }
    }
  }
  return [...points].sort((a, b) => a - b)
}

/**
 * The final on-call timeline between `from` and `to`: consecutive shifts of the same person are
 * merged, gaps (nobody on call) are left out. Pass `userId` to keep only that member's shifts.
 */
export function shiftsBetween(
  schedule: ScheduleDefinition,
  from: Date,
  to: Date,
  options: { userId?: OnCallId } = {},
): OnCallShift[] {
  if (to.getTime() <= from.getTime()) return []
  const edges = [from.getTime(), ...changePoints(schedule, from, to), to.getTime()]
  const shifts: OnCallShift[] = []
  for (let i = 0; i < edges.length - 1; i++) {
    const result = onCallAt(schedule, new Date(edges[i]))
    if (!result) continue
    const previous = shifts.at(-1)
    if (
      previous &&
      previous.userId === result.userId &&
      previous.source === result.source &&
      previous.end.getTime() === edges[i]
    ) {
      previous.end = new Date(edges[i + 1])
    } else {
      shifts.push({
        userId: result.userId,
        source: result.source,
        start: new Date(edges[i]),
        end: new Date(edges[i + 1]),
      })
    }
  }
  if (options.userId === undefined) return shifts
  return shifts.filter((shift) => shift.userId === String(options.userId))
}

/** The step and round an escalation moves to after `step` of `round`, or `null` when done. */
export function nextEscalationStep(
  stepCount: number,
  repeat: number,
  step: number,
  round: number,
): { step: number; round: number } | null {
  if (step + 1 < stepCount) return { step: step + 1, round }
  if (round < Math.min(Math.max(0, repeat), MAX_ESCALATION_REPEATS))
    return { step: 0, round: round + 1 }
  return null
}

/**
 * The escalation fields to write when an acknowledgement or resolution stops an active
 * escalation; `undefined` when there is none.
 */
export function stoppedEscalation<
  E extends { status?: EscalationStatus | null; nextAt?: string | null },
>(incident: { escalation?: E | null }): (E & { status: 'stopped'; nextAt: null }) | undefined {
  if (incident.escalation?.status !== 'active') return undefined
  return { ...incident.escalation, status: 'stopped', nextAt: null }
}

/** Serialized schedule for the dashboard and the API. */
export interface OnCallScheduleSummary {
  id: string
  name: string
  description: string | null
  timezone: string
  layers: {
    name: string
    timezone: string | null
    rotation: RotationType
    customLength: number | null
    customUnit: RotationUnit
    handoffTime: string
    startDate: string
    members: { id: string; name: string }[]
    restrictions: LayerRestriction[]
  }[]
  overrides: {
    id: string
    user: { id: string; name: string }
    start: string
    end: string
    note: string | null
  }[]
  /** Who is on call right now (or at the requested instant). */
  onCall: {
    user: { id: string; name: string }
    source: 'override' | 'layer'
    until: string | null
  } | null
}

export interface EscalationPolicySummary {
  id: string
  name: string
  description: string | null
  repeat: number
  steps: {
    escalateAfterMinutes: number
    targets: { type: EscalationTargetType; id: string; name: string }[]
  }[]
  monitors: { id: string; name: string }[]
}

export interface OnCallShiftSummary {
  scheduleId: string
  scheduleName: string
  user: { id: string; name: string }
  source: 'override' | 'layer'
  start: string
  end: string
}
