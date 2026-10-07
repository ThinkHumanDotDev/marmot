/**
 * Extension point for "an incident update was posted". The `incidents` collection emits one event per
 * new timeline entry (`afterChange`), inside the write's transaction: listeners that tell another
 * process (BullMQ) or write rows referencing the incident defer that work with
 * `afterCommit(event.req, …)`. Subscriber notifications (#104,
 * `src/server/status-pages/subscribers/events.ts`) listen here. Listeners must not throw; errors are
 * logged and swallowed so a failing listener never fails the write.
 *
 * Updates synthesized from a legacy incident (see `legacyUpdate`) are not announced.
 */
import type { Payload, PayloadRequest } from 'payload'

import type { IncidentStatus } from '@/lib/incident-timeline'
import type { Incident } from '@/payload-types'

export type IncidentUpdateRow = NonNullable<Incident['updates']>[number]

export interface IncidentUpdatePostedEvent {
  payload: Payload
  /** The write's request (its transaction); pass it to `afterCommit`. */
  req: PayloadRequest
  incident: Incident
  update: IncidentUpdateRow
  /** `opened` for the incident's first update, `resolved` / `reopened` on state changes, else `updated`. */
  kind: 'opened' | 'updated' | 'resolved' | 'reopened'
  previousStatus: IncidentStatus | null
}

export type IncidentUpdatePostedListener = (
  event: IncidentUpdatePostedEvent,
) => Promise<void> | void

const listeners = new Set<IncidentUpdatePostedListener>()

/** Registers a listener; returns the function that removes it. */
export function onIncidentUpdatePosted(listener: IncidentUpdatePostedListener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Called by the `incidents` collection for every newly posted update. */
export async function emitIncidentUpdatePosted(event: IncidentUpdatePostedEvent): Promise<void> {
  for (const listener of listeners) {
    try {
      await listener(event)
    } catch (error) {
      event.payload.logger.error(
        { err: error, incident: event.incident.id },
        'incident update listener failed',
      )
    }
  }
}
