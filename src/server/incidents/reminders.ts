/**
 * Reminder policy: decides whether a resend-interval reminder (a DOWN beat the state machine flagged
 * with `notify` without a status change) goes out, given the monitor's open incident.
 *
 * The default holds reminders back while the incident is acknowledged (#100). It is a plain function
 * so the reminder backoff of #147 (linear / exponential spacing, `maxReminders`) can replace it with
 * `setReminderPolicy()` and read the bookkeeping kept on the incident (`remindersSent`,
 * `lastReminderAt`, `acknowledgedAt`). The gate that calls it lives in `listener.ts`.
 */
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

/** A beat that notifies without a status change: a resend-interval reminder. */
export const isReminderBeat = (event: Pick<HeartbeatEvent, 'notify' | 'heartbeat'>): boolean =>
  event.notify && !event.heartbeat.important && event.heartbeat.status === 'down'

/** Default: no reminders while someone has acknowledged the incident. */
export const suppressWhenAcknowledged: ReminderPolicy = ({ incident }) =>
  incident?.status !== 'acknowledged'

let policy: ReminderPolicy = suppressWhenAcknowledged

/** Replace the reminder policy; `null` restores the default. */
export function setReminderPolicy(next: ReminderPolicy | null): void {
  policy = next ?? suppressWhenAcknowledged
}

export function getReminderPolicy(): ReminderPolicy {
  return policy
}
