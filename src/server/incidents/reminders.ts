/**
 * Reminder policy: decides whether a resend-interval reminder (a DOWN beat the state machine flagged
 * with `notify` without a status change) goes out, given the monitor's open incident.
 *
 * The default (`backoffReminderPolicy`) holds reminders back while the incident is acknowledged
 * (#100) and applies the monitor's reminder backoff (#147): `reminderBackoff` spaces reminders
 * linearly or exponentially and `maxReminders` caps them, using the bookkeeping kept on the incident
 * (`remindersSent`, `lastReminderAt`). With the defaults (`none`, 0) it sends every tick, as Uptime
 * Kuma does. `setReminderPolicy()` replaces it; the gate that calls it lives in `listener.ts`.
 */
import { isReminderDue } from '@/lib/reminder-backoff'
import type { MonitorIncident } from '@/payload-types'
import type { HeartbeatEvent } from '@/server/engine/hooks'

export interface ReminderContext {
  event: HeartbeatEvent
  /** The monitor's unresolved incident (`null` when there is none, e.g. resolved by hand). */
  incident: MonitorIncident | null
  now: Date
}

/** `true` to send the reminder, `false` to hold it back. */
export type ReminderPolicy = (context: ReminderContext) => boolean | Promise<boolean>

/** A resend-interval reminder (the engine's `reminder` notification event). */
export const isReminderBeat = (
  event: Pick<HeartbeatEvent, 'notify' | 'heartbeat' | 'notificationEvent'>,
): boolean =>
  event.notificationEvent !== undefined
    ? event.notificationEvent === 'reminder'
    : event.notify && !event.heartbeat.important && event.heartbeat.status === 'down'

/** Default: no reminders while someone has acknowledged the incident. */
export const suppressWhenAcknowledged: ReminderPolicy = ({ incident }) =>
  incident?.status !== 'acknowledged'

/** Base reminder interval in seconds: one resend tick (`resendInterval` DOWN beats of `interval`). */
export const reminderBaseSeconds = (monitor: {
  interval?: number | null
  resendInterval?: number | null
}): number => Math.max(0, monitor.resendInterval ?? 0) * Math.max(1, monitor.interval ?? 0)

/**
 * Default: no reminders while acknowledged; otherwise the monitor's backoff and cap decide. Without
 * an open incident (resolved by hand) there is no bookkeeping, so every tick goes out.
 */
export const backoffReminderPolicy: ReminderPolicy = ({ event, incident, now }) => {
  if (!suppressWhenAcknowledged({ event, incident, now })) return false
  if (!incident) return true
  return isReminderDue({
    backoff: event.monitor.reminderBackoff,
    maxReminders: event.monitor.maxReminders,
    remindersSent: incident.remindersSent,
    lastReminderAt: incident.lastReminderAt,
    baseSeconds: reminderBaseSeconds(event.monitor),
    now,
  })
}

let policy: ReminderPolicy = backoffReminderPolicy

/** Replace the reminder policy; `null` restores the default. */
export function setReminderPolicy(next: ReminderPolicy | null): void {
  policy = next ?? backoffReminderPolicy
}

export function getReminderPolicy(): ReminderPolicy {
  return policy
}
