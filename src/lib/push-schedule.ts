/**
 * Push monitor schedules, grace periods and runs: the pure rules shared by the worker's push check,
 * the push endpoint and the UI ("next expected ping"). Nothing here touches the database or the
 * clock: callers pass `now`.
 *
 * Semantics follow healthchecks.io (BSD-3-Clause) for cron schedules and start/success/fail signals:
 * after a ping, the next one is expected at the next schedule occurrence; the monitor goes DOWN once
 * that occurrence plus the grace period has passed. A `start` signal opens a run that must finish
 * (success or failure) within the grace period.
 */
import { Cron } from 'croner'

export const PUSH_SCHEDULE_TYPES = ['interval', 'cron'] as const
export type PushScheduleType = (typeof PUSH_SCHEDULE_TYPES)[number]

/** Signals the push endpoint understands (`/api/push/:token[/start|/fail|/log|/:exitCode]`). */
export const PUSH_SIGNAL_KINDS = ['success', 'fail', 'start', 'log'] as const
export type PushSignalKind = (typeof PUSH_SIGNAL_KINDS)[number]

/** Bytes of a request body kept as the event log (also sent as the `Ping-Body-Limit` header). */
export const PUSH_BODY_LIMIT_BYTES = 10_000
/** Characters of `msg` kept (unchanged from the original endpoint). */
export const PUSH_MSG_MAX_LENGTH = 250
/** Ping events kept per monitor; older ones are pruned on insert. */
export const PUSH_EVENTS_PER_MONITOR = 100
/** Open runs remembered per monitor (overlapping `rid` runs); the oldest are forgotten first. */
export const MAX_OPEN_RUNS = 10
/** Cron schedules are evaluated every minute, whatever `interval` says. */
export const PUSH_CRON_CHECK_SECONDS = 60
/** Grace period of a cron schedule when none is configured. */
export const DEFAULT_CRON_GRACE_SECONDS = 60
/** Upper bound of `pushGrace` and `pushMaxDuration` (one year, like `interval`). */
export const MAX_PUSH_SECONDS = 24 * 60 * 60 * 365
/** `rid` values: a UUID or any short token of letters, digits, `-` and `_`. */
export const RUN_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

/** Monitor fields that define when pings are expected. `timezone` is already resolved. */
export interface PushScheduleSettings {
  interval: number
  pushSchedule?: PushScheduleType | null
  pushCron?: string | null
  /** IANA zone the cron expression is evaluated in. */
  timezone?: string | null
  /** Seconds; `null` = automatic (10 % of the interval, at least 1 s; 60 s for cron). */
  pushGrace?: number | null
  /** Seconds; runs longer than this are reported DOWN. */
  pushMaxDuration?: number | null
}

/** An open run: a `start` signal without its success/failure yet. */
export interface PushRun {
  rid: string | null
  startedAt: string
}

/** The monitor's push bookkeeping (`monitors.status`). */
export interface PushState {
  /** Last success or failure signal. */
  lastPushAt?: string | null
  /** Outcome of that signal. */
  lastPushStatus?: 'up' | 'down' | null
  runs?: PushRun[] | null
  /** Anchor before the first ping (the monitor's creation): cron schedules wait for the first run. */
  since?: string | null
}

/** Monitor fields `pushStateOf` reads (a `monitors` document). */
export interface PushStateSource {
  createdAt?: string | null
  status?: {
    lastPushAt?: string | null
    lastPushStatus?: 'up' | 'down' | null
    pushRuns?: unknown
  } | null
}

/** Runs stored in `status.pushRuns` (JSON), defensively parsed. */
export function storedPushRuns(monitor: PushStateSource): PushRun[] {
  const raw = monitor.status?.pushRuns
  if (!Array.isArray(raw)) return []
  return raw.flatMap((item: unknown) => {
    if (!item || typeof item !== 'object') return []
    const { rid, startedAt } = item as { rid?: unknown; startedAt?: unknown }
    if (typeof startedAt !== 'string') return []
    return [{ rid: typeof rid === 'string' ? rid : null, startedAt }]
  })
}

/** The push bookkeeping of a monitor document, as `evaluatePush` reads it. */
export function pushStateOf(monitor: PushStateSource): PushState {
  return {
    lastPushAt: monitor.status?.lastPushAt ?? null,
    lastPushStatus: monitor.status?.lastPushStatus ?? null,
    runs: storedPushRuns(monitor),
    since: monitor.createdAt ?? null,
  }
}

export type PushEvaluation =
  | { status: 'up'; reason: 'ok'; ageSeconds: number; nextExpectedAt: Date | null }
  | {
      status: 'up'
      reason: 'running'
      run: PushRun
      ageSeconds: number
      nextExpectedAt: Date | null
    }
  | { status: 'pending'; reason: 'waiting'; nextExpectedAt: Date | null }
  | {
      status: 'down'
      reason: 'no-ping' | 'late' | 'failed'
      ageSeconds: number | null
      nextExpectedAt: Date | null
    }
  | { status: 'down'; reason: 'run-timeout' | 'run-too-long'; run: PushRun; ageSeconds: number }
  | { status: 'down'; reason: 'invalid-schedule' }

const toTime = (value: string | Date | null | undefined): number | null => {
  if (!value) return null
  const time = new Date(value).getTime()
  return Number.isFinite(time) ? time : null
}

export const isCronSchedule = (settings: Pick<PushScheduleSettings, 'pushSchedule'>): boolean =>
  settings.pushSchedule === 'cron'

/** The original push grace: 10 % of the interval, at least 1 s (clock drift, scheduler jitter). */
export function legacyGraceMs(intervalSeconds: number): number {
  return Math.max(1000, Math.round(Math.max(1, intervalSeconds) * 1000 * 0.1))
}

/** Grace period in ms: the configured one, otherwise the automatic default of the schedule. */
export function pushGraceMs(settings: PushScheduleSettings): number {
  if (typeof settings.pushGrace === 'number' && settings.pushGrace >= 0) {
    return settings.pushGrace * 1000
  }
  return isCronSchedule(settings)
    ? DEFAULT_CRON_GRACE_SECONDS * 1000
    : legacyGraceMs(settings.interval)
}

/** `true` when croner parses `pattern` (5 fields, or 6 with seconds). */
export function isValidCronPattern(pattern: string | null | undefined): boolean {
  if (!pattern?.trim()) return false
  try {
    new Cron(pattern.trim(), { timezone: 'UTC' })
    return true
  } catch {
    return false
  }
}

/**
 * When the next ping is due after one at `after`: `after + interval`, or the next occurrence of the
 * cron expression in the schedule's zone (croner handles DST: a skipped wall-clock time runs at the
 * first valid instant after it, a repeated one runs once). `null` for an invalid cron expression.
 */
export function nextExpectedAt(settings: PushScheduleSettings, after: Date): Date | null {
  if (!isCronSchedule(settings)) {
    return new Date(after.getTime() + Math.max(1, settings.interval) * 1000)
  }
  try {
    const cron = new Cron((settings.pushCron ?? '').trim(), {
      timezone: settings.timezone || 'UTC',
    })
    return cron.nextRun(after)
  } catch {
    return null
  }
}

/** The next `count` occurrences of a cron expression after `after` (UI preview). */
export function nextCronRuns(
  pattern: string,
  timezone: string,
  count: number,
  after: Date,
): Date[] | null {
  try {
    return new Cron(pattern.trim(), { timezone }).nextRuns(count, after)
  } catch {
    return null
  }
}

/**
 * Decide the state of a push monitor at `now`. Order of precedence:
 *
 * 1. an open run past its grace period (or `pushMaxDuration`) → DOWN,
 * 2. the last signal was a failure → DOWN until the next success,
 * 3. an open run within its grace period → UP ("running"),
 * 4. no ping yet → interval schedules are DOWN at once (original behaviour), cron schedules are
 *    PENDING until the first occurrence after `since` plus grace has passed,
 * 5. the next expected ping plus grace has passed → DOWN ("late"),
 * 6. otherwise UP.
 */
export function evaluatePush(
  settings: PushScheduleSettings,
  state: PushState,
  now: Date,
): PushEvaluation {
  const nowMs = now.getTime()
  const graceMs = pushGraceMs(settings)
  const maxMs =
    typeof settings.pushMaxDuration === 'number' && settings.pushMaxDuration > 0
      ? settings.pushMaxDuration * 1000
      : null
  const cron = isCronSchedule(settings)
  if (cron && !isValidCronPattern(settings.pushCron)) {
    return { status: 'down', reason: 'invalid-schedule' }
  }

  const runs = (state.runs ?? [])
    .map((run) => ({ run, start: toTime(run.startedAt) }))
    .filter((r): r is { run: PushRun; start: number } => r.start !== null)
    .sort((a, b) => a.start - b.start)

  for (const { run, start } of runs) {
    const age = nowMs - start
    if (maxMs !== null && age > maxMs) {
      return { status: 'down', reason: 'run-too-long', run, ageSeconds: Math.round(age / 1000) }
    }
    if (age > graceMs) {
      return { status: 'down', reason: 'run-timeout', run, ageSeconds: Math.round(age / 1000) }
    }
  }

  const lastAt = toTime(state.lastPushAt)
  const anchor = lastAt ?? toTime(state.since)
  const next = anchor !== null ? nextExpectedAt(settings, new Date(anchor)) : null
  const ageSeconds = lastAt !== null ? Math.round((nowMs - lastAt) / 1000) : null

  if (lastAt !== null && state.lastPushStatus === 'down') {
    return { status: 'down', reason: 'failed', ageSeconds, nextExpectedAt: next }
  }

  const newest = runs.at(-1)
  if (newest) {
    return {
      status: 'up',
      reason: 'running',
      run: newest.run,
      ageSeconds: Math.round((nowMs - newest.start) / 1000),
      nextExpectedAt: next,
    }
  }

  if (lastAt === null) {
    if (!cron || next === null) {
      return { status: 'down', reason: 'no-ping', ageSeconds: null, nextExpectedAt: next }
    }
    if (nowMs > next.getTime() + graceMs) {
      return { status: 'down', reason: 'no-ping', ageSeconds: null, nextExpectedAt: next }
    }
    return { status: 'pending', reason: 'waiting', nextExpectedAt: next }
  }

  if (next === null || nowMs > next.getTime() + graceMs) {
    return { status: 'down', reason: 'late', ageSeconds, nextExpectedAt: next }
  }
  return { status: 'up', reason: 'ok', ageSeconds: ageSeconds ?? 0, nextExpectedAt: next }
}

/** Add a run for a `start` signal (a restarted `rid` replaces its previous run). */
export function openRun(
  runs: PushRun[] | null | undefined,
  rid: string | null,
  now: Date,
): PushRun[] {
  const kept = (runs ?? []).filter((run) => rid === null || run.rid !== rid)
  const withoutRid = rid === null ? kept.filter((run) => run.rid !== null) : kept
  // Without a rid only one anonymous run exists at a time: a new start restarts it.
  const next = [...withoutRid, { rid, startedAt: now.toISOString() }]
  return next.slice(-MAX_OPEN_RUNS)
}

/**
 * Close the run a success/failure signal belongs to: the run with the same `rid`, otherwise the
 * latest anonymous run, otherwise the latest run. Runs already past the grace period (they were
 * reported DOWN) are dropped as well.
 */
export function closeRun(
  runs: PushRun[] | null | undefined,
  rid: string | null,
  now: Date,
  graceMs: number,
): { run: PushRun | null; durationMs: number | null; runs: PushRun[] } {
  const list = runs ?? []
  let match: PushRun | undefined
  if (rid !== null) match = list.find((run) => run.rid === rid)
  else match = [...list].reverse().find((run) => run.rid === null) ?? list.at(-1)

  const start = match ? toTime(match.startedAt) : null
  const durationMs = start !== null ? Math.max(0, now.getTime() - start) : null
  const remaining = list.filter((run) => {
    if (run === match) return false
    const runStart = toTime(run.startedAt)
    return runStart !== null && now.getTime() - runStart <= graceMs
  })
  return { run: match ?? null, durationMs, runs: remaining }
}

// ---- Plain-language description ----------------------------------------------------------------

export type CronDescription =
  | { kind: 'everyMinute' }
  | { kind: 'everyMinutes'; minutes: number }
  | { kind: 'hourly'; minute: number }
  | { kind: 'everyHours'; hours: number; minute: number }
  | { kind: 'daily'; time: string }
  | { kind: 'weekly'; weekdays: number[]; time: string }
  | { kind: 'monthly'; day: number; time: string }

const WEEKDAY_NAMES = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT']

const parseNumber = (value: string, min: number, max: number): number | null => {
  if (!/^\d{1,2}$/.test(value)) return null
  const n = Number(value)
  return n >= min && n <= max ? n : null
}

const parseStep = (value: string): number | null => {
  const match = /^\*\/(\d{1,2})$/.exec(value)
  return match ? Number(match[1]) || null : null
}

const parseWeekday = (value: string): number | null => {
  const named = WEEKDAY_NAMES.indexOf(value.toUpperCase())
  if (named >= 0) return named
  const n = parseNumber(value, 0, 7)
  return n === null ? null : n % 7
}

/** `1-5`, `MON,WED`, `0,6` → sorted unique weekdays (0 = Sunday), or `null`. */
function parseWeekdays(field: string): number[] | null {
  const days = new Set<number>()
  for (const part of field.split(',')) {
    const range = part.split('-')
    if (range.length === 1) {
      const day = parseWeekday(range[0])
      if (day === null) return null
      days.add(day)
    } else if (range.length === 2) {
      const from = parseWeekday(range[0])
      const to = parseWeekday(range[1])
      if (from === null || to === null) return null
      const end = range[1] === '7' ? 7 : to
      if (end < from) return null
      for (let d = from; d <= end; d++) days.add(d % 7)
    } else return null
  }
  return [...days].sort((a, b) => a - b)
}

const pad = (n: number) => String(n).padStart(2, '0')

/**
 * Describe the common five-field shapes (every N minutes, hourly, daily, weekly, monthly) so the UI
 * can say "every day at 02:00". Anything else returns `null` and is shown verbatim.
 */
export function describeCron(pattern: string | null | undefined): CronDescription | null {
  const fields = (pattern ?? '').trim().split(/\s+/)
  if (fields.length !== 5) return null
  const [min, hour, dom, mon, dow] = fields
  if (mon !== '*') return null

  if (min === '*' && hour === '*' && dom === '*' && dow === '*') return { kind: 'everyMinute' }
  const minuteStep = parseStep(min)
  if (minuteStep && hour === '*' && dom === '*' && dow === '*') {
    return { kind: 'everyMinutes', minutes: minuteStep }
  }

  const minute = parseNumber(min, 0, 59)
  if (minute === null) return null
  if (dom === '*' && dow === '*') {
    if (hour === '*') return { kind: 'hourly', minute }
    const hourStep = parseStep(hour)
    if (hourStep) return { kind: 'everyHours', hours: hourStep, minute }
  }

  const h = parseNumber(hour, 0, 23)
  if (h === null) return null
  const time = `${pad(h)}:${pad(minute)}`
  if (dom === '*' && dow === '*') return { kind: 'daily', time }
  if (dom === '*') {
    const weekdays = parseWeekdays(dow)
    return weekdays ? { kind: 'weekly', weekdays, time } : null
  }
  if (dow === '*') {
    const day = parseNumber(dom, 1, 31)
    return day === null ? null : { kind: 'monthly', day, time }
  }
  return null
}

/** Crontab line for the snippet: the monitor's own expression, or one close to its interval. */
export function crontabPattern(settings: PushScheduleSettings): string {
  if (isCronSchedule(settings) && settings.pushCron?.trim()) return settings.pushCron.trim()
  const minutes = Math.round(Math.max(60, settings.interval) / 60)
  if (minutes <= 1) return '* * * * *'
  if (minutes < 60 && 60 % minutes === 0) return `*/${minutes} * * * *`
  if (minutes < 60 * 24 && minutes % 60 === 0 && 24 % (minutes / 60) === 0) {
    return minutes === 60 ? '0 * * * *' : `0 */${minutes / 60} * * *`
  }
  return '0 * * * *'
}
