/**
 * Notification gates: a veto point between the engine's `notify` decision and the dispatcher.
 *
 * `registerNotificationListener` asks every registered gate before enqueuing a beat's
 * notifications; any gate answering `false` suppresses them. Monitor incidents (#100) register one
 * that holds back resend-interval reminders while the incident is acknowledged; the reminder policy
 * behind it is pluggable (`setReminderPolicy` in `src/server/incidents/reminders.ts`). A gate that
 * throws is logged and ignored, so a broken gate never silences an outage.
 */
import { childLogger } from '@/lib/logger'
import type { HeartbeatEvent } from '@/server/engine/hooks'

const log = childLogger('notifications:gates')

export type NotificationGate = (event: HeartbeatEvent) => boolean | Promise<boolean>

const gates = new Set<NotificationGate>()

/** Add a gate; returns the function that removes it. */
export function registerNotificationGate(gate: NotificationGate): () => void {
  gates.add(gate)
  return () => {
    gates.delete(gate)
  }
}

/** Remove every gate (tests). */
export function clearNotificationGates(): void {
  gates.clear()
}

/** `true` unless a gate vetoes the beat's notifications. */
export async function passesNotificationGates(event: HeartbeatEvent): Promise<boolean> {
  for (const gate of gates) {
    try {
      if ((await gate(event)) === false) return false
    } catch (err) {
      log.error({ err, monitorId: event.monitor.id }, 'notification gate failed; ignoring it')
    }
  }
  return true
}
