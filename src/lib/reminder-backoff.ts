/**
 * Reminder backoff (#147): how resend-interval reminders are spaced while a monitor stays DOWN.
 * Pure and client-safe, so the collection, the form schema and the reminder policy share it.
 *
 * The engine still flags a reminder every `resendInterval` DOWN beats (the Uptime Kuma tick); the
 * reminder policy (`src/server/incidents/reminders.ts`) lets a tick through only when the backoff says
 * the next reminder is due. With `base = resendInterval × interval` seconds, reminder `k` (0-based)
 * waits `factor(k) × base` after the previous one:
 *
 * - `none`: 1, 1, 1, … (every tick, the Uptime Kuma behaviour and the default)
 * - `linear`: 1, 2, 3, …
 * - `exponential`: 1, 2, 4, 8, …
 *
 * `maxReminders` (0 = unlimited) stops reminders after that many were sent for an incident.
 */

export const REMINDER_BACKOFFS = ['none', 'linear', 'exponential'] as const
export type ReminderBackoff = (typeof REMINDER_BACKOFFS)[number]

export const isReminderBackoff = (value: unknown): value is ReminderBackoff =>
  typeof value === 'string' && (REMINDER_BACKOFFS as readonly string[]).includes(value)

/** Upper bound for `maxReminders` and `successThreshold` in forms and imports. */
export const MAX_REMINDERS_LIMIT = 1000
export const MAX_SUCCESS_THRESHOLD = 100

/** Gap before reminder number `sent` (0-based), in multiples of the base interval. */
export function reminderGapFactor(backoff: ReminderBackoff, sent: number): number {
  const k = Math.max(0, Math.floor(sent))
  if (backoff === 'linear') return k + 1
  // 2^30 base intervals is decades; the cap only keeps the number finite.
  if (backoff === 'exponential') return 2 ** Math.min(k, 30)
  return 1
}

export interface ReminderDueInput {
  backoff?: string | null
  /** 0 or empty = unlimited. */
  maxReminders?: number | null
  /** Reminders already sent for the incident. */
  remindersSent?: number | null
  /** When the previous reminder went out (ISO string or Date). */
  lastReminderAt?: string | Date | null
  /** Base interval in seconds (`resendInterval × interval`). */
  baseSeconds: number
  now: Date
}

/**
 * Is the next reminder due? Elapsed time is measured in whole base intervals (rounded), so a tick
 * that arrives a little early or late still counts as the tick it is.
 */
export function isReminderDue(input: ReminderDueInput): boolean {
  const sent = Math.max(0, input.remindersSent ?? 0)
  const max = input.maxReminders ?? 0
  if (max > 0 && sent >= max) return false

  const backoff = isReminderBackoff(input.backoff) ? input.backoff : 'none'
  if (backoff === 'none' || sent === 0 || !input.lastReminderAt) return true
  if (!(input.baseSeconds > 0)) return true

  const last = new Date(input.lastReminderAt).getTime()
  if (Number.isNaN(last)) return true
  const elapsedIntervals = Math.round((input.now.getTime() - last) / (input.baseSeconds * 1000))
  return elapsedIntervals >= reminderGapFactor(backoff, sent)
}
