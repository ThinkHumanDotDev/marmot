/**
 * Maintenance announcement events: the hook point for subscriber notifications (#104).
 *
 * `syncMaintenance()` and `postOccurrenceUpdate()` call `dispatchMaintenanceEvents()` once the
 * change is committed, in whichever process made it: the worker for automatic transitions and
 * reminders (delayed BullMQ jobs and the minute reconciler), the web process for updates posted by
 * an admin. Subscriber delivery (#104) registers a listener with `registerMaintenanceEventListener`
 * in both processes and enqueues its own deduplicated jobs (e.g. job id
 * `maint-<occurrence>-<type>-<update id | reminder minutes>`); listeners must not throw.
 *
 * | type        | when                                                                          |
 * | ----------- | ----------------------------------------------------------------------------- |
 * | `scheduled` | an occurrence is announced (created ahead of its start)                       |
 * | `reminder`  | a configured offset before the start is reached (once per occurrence/offset) |
 * | `started`   | the occurrence goes in progress (automatically or by an admin)                |
 * | `updated`   | an update is posted without finishing it (notes, `verifying`, back to running) |
 * | `completed` | the occurrence completes (end reached with autoComplete, or by an admin)      |
 * | `cancelled` | an upcoming occurrence is cancelled                                           |
 */
import type { Payload } from 'payload'

import { childLogger } from '@/lib/logger'
import type {
  OccurrenceState,
  OccurrenceSummary,
  OccurrenceUpdate,
} from '@/lib/maintenance-announcements'
import type { MaintenanceStrategy } from '@/lib/validation/maintenance'

const log = childLogger('maintenance:events')

export const MAINTENANCE_EVENT_TYPES = [
  'scheduled',
  'reminder',
  'started',
  'updated',
  'completed',
  'cancelled',
] as const
export type MaintenanceEventType = (typeof MAINTENANCE_EVENT_TYPES)[number]

export interface MaintenanceEvent {
  type: MaintenanceEventType
  organizationId: string
  maintenance: {
    id: string
    title: string
    description: string | null
    strategy: MaintenanceStrategy
    /** Status pages announcing the maintenance: whose subscribers to notify. */
    statusPages: string[]
    monitors: string[]
  }
  occurrence: OccurrenceSummary
  /** The timeline entry this event added (null for `scheduled` and `reminder`). */
  update: OccurrenceUpdate | null
  /** Offset before the start, for `reminder` events. */
  reminderMinutes: number | null
  /** ISO time the event happened. */
  at: string
}

export type MaintenanceEventListener = (
  event: MaintenanceEvent,
  payload: Payload,
) => void | Promise<void>

const listeners = new Set<MaintenanceEventListener>()

/** Subscribe to maintenance events; returns the unsubscribe function. */
export function registerMaintenanceEventListener(listener: MaintenanceEventListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Drop every listener (tests). */
export function clearMaintenanceEventListeners(): void {
  listeners.clear()
}

/** Event type of a state change (`from === to` is a note). */
export function eventTypeFor(from: OccurrenceState, to: OccurrenceState): MaintenanceEventType {
  if (from !== to) {
    if (to === 'completed') return 'completed'
    if (to === 'cancelled') return 'cancelled'
    if (to === 'in-progress' && from === 'scheduled') return 'started'
  }
  return 'updated'
}

/**
 * Hand events to every listener, in order. Never throws: a failing listener is logged and the
 * others still run, so notifications can never break a transition.
 */
export async function dispatchMaintenanceEvents(
  payload: Payload,
  events: readonly MaintenanceEvent[],
): Promise<void> {
  for (const event of events) {
    log.info(
      {
        type: event.type,
        maintenanceId: event.maintenance.id,
        occurrenceId: event.occurrence.id,
        reminderMinutes: event.reminderMinutes ?? undefined,
      },
      'maintenance event',
    )
    for (const listener of listeners) {
      try {
        await listener(event, payload)
      } catch (err) {
        log.error({ err, type: event.type }, 'maintenance event listener failed')
      }
    }
  }
}
