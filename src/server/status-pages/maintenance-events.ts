/**
 * Maintenance of a status page for the machine-readable outputs (the iCalendar feed, the
 * Statuspage-compatible `scheduled_maintenances` and the Markdown page), read from the persisted
 * `maintenance-occurrences` (#154, `src/server/maintenance/occurrences.ts`): one event per occurrence,
 * with its lifecycle state (`scheduled`, `in-progress`, `verifying`, `completed`, `cancelled`) and
 * its update timeline. Nothing is computed from the schedule here.
 */
import type { Payload } from 'payload'

import {
  isFinishedState,
  UNFINISHED_OCCURRENCE_STATES,
  type OccurrenceState,
  type OccurrenceUpdate,
} from '@/lib/maintenance-announcements'
import type { MaintenanceStrategy } from '@/lib/validation/maintenance'
import type { Maintenance, MaintenanceOccurrence, StatusPage } from '@/payload-types'
import { toOccurrenceUpdate } from '@/server/maintenance/occurrences'
import { relationId } from '@/server/maintenance/serialize'
import { getActiveMaintenanceForStatusPage } from '@/server/maintenance/status-page'
import { resolveTimezone } from '@/server/maintenance/status'
import { getOrganizationTimezone } from '@/server/maintenance/timezone'

export interface MaintenanceEvent {
  /** Occurrence id (stable for the life of the window). */
  id: string
  maintenanceId: string
  title: string
  description: string | null
  strategy: MaintenanceStrategy
  state: OccurrenceState
  /**
   * The maintenance is paused: an unfinished occurrence will not happen as planned (the public page
   * hides it; the calendar marks it cancelled).
   */
  paused: boolean
  /** ISO planned start. */
  start: string
  /** ISO planned end; null for manual maintenance. */
  end: string | null
  startedAt: string | null
  completedAt: string | null
  cancelledAt: string | null
  /** IANA zone the window was planned in. */
  timezone: string
  /** Monitors the maintenance covers (string ids). */
  monitorIds: string[]
  createdAt: string
  /** Last change of the occurrence or its maintenance. */
  updatedAt: string
  /** Revision for iCalendar `SEQUENCE`: seconds between creation and the last change. */
  sequence: number
  /** Timeline, oldest first. */
  updates: OccurrenceUpdate[]
}

/** Finished occurrences older than this are left out (the history page, #107, has them). */
export const RECENT_DAYS = 30
const DAY_MS = 24 * 60 * 60_000

const latest = (...values: (string | null | undefined)[]): string =>
  values.reduce<string>((best, v) => (v && Date.parse(v) > (Date.parse(best) || 0) ? v : best), '')

export function eventSequence(createdAt: string, updatedAt: string): number {
  const created = Date.parse(createdAt)
  const updated = Date.parse(updatedAt)
  if (Number.isNaN(created) || Number.isNaN(updated)) return 0
  return Math.max(0, Math.floor((updated - created) / 1000))
}

/** True when the occurrence will not (or did not) take place. */
export const isCancelledEvent = (event: Pick<MaintenanceEvent, 'state' | 'paused'>): boolean =>
  event.state === 'cancelled' || (event.paused && !isFinishedState(event.state))

/**
 * Occurrences of every maintenance attached to the page: unfinished ones, and finished ones whose
 * window started or ended within the last `RECENT_DAYS`. Ordered by planned start.
 */
export async function listMaintenanceEvents(
  payload: Payload,
  pageId: string | number,
  { now = new Date() }: { now?: Date } = {},
): Promise<MaintenanceEvent[]> {
  const { docs: maintenances } = await payload.find({
    collection: 'maintenance',
    where: { statusPages: { equals: pageId } },
    depth: 0,
    limit: 100,
    pagination: false,
    overrideAccess: true,
  })
  if (maintenances.length === 0) return []
  const byId = new Map((maintenances as Maintenance[]).map((m) => [String(m.id), m]))

  const since = new Date(now.getTime() - RECENT_DAYS * DAY_MS).toISOString()
  const { docs: occurrences } = await payload.find({
    collection: 'maintenance-occurrences',
    where: {
      and: [
        { maintenance: { in: (maintenances as Maintenance[]).map((m) => m.id) } },
        {
          or: [
            { state: { in: [...UNFINISHED_OCCURRENCE_STATES] } },
            { start: { greater_than_equal: since } },
            { completedAt: { greater_than_equal: since } },
            { cancelledAt: { greater_than_equal: since } },
          ],
        },
      ],
    },
    sort: 'start',
    depth: 0,
    limit: 500,
    pagination: false,
    overrideAccess: true,
  })

  const zones = new Map<string, string>()
  const events: MaintenanceEvent[] = []
  for (const occurrence of occurrences as MaintenanceOccurrence[]) {
    const maintenanceId = String(relationId(occurrence.maintenance))
    const doc = byId.get(maintenanceId)
    if (!doc) continue
    let timezone = zones.get(maintenanceId)
    if (!timezone) {
      const serverTimezone = await getOrganizationTimezone(payload, relationId(doc.organization))
      timezone = resolveTimezone(doc.timezone, serverTimezone)
      zones.set(maintenanceId, timezone)
    }
    const updatedAt = latest(occurrence.updatedAt, doc.updatedAt) || occurrence.updatedAt
    events.push({
      id: String(occurrence.id),
      maintenanceId,
      title: doc.title,
      description: doc.description?.trim() || null,
      strategy: doc.strategy,
      state: occurrence.state,
      paused: doc.active === false,
      start: occurrence.start,
      end: occurrence.end ?? null,
      startedAt: occurrence.startedAt ?? null,
      completedAt: occurrence.completedAt ?? null,
      cancelledAt: occurrence.cancelledAt ?? null,
      timezone,
      monitorIds: (doc.monitors ?? [])
        .map(relationId)
        .filter((id) => id !== null)
        .map(String),
      createdAt: occurrence.createdAt,
      updatedAt,
      sequence: eventSequence(occurrence.createdAt, updatedAt),
      updates: (occurrence.updates ?? []).map(toOccurrenceUpdate),
    })
  }
  return events
}

/**
 * What the public page announces right now and is not finished: running occurrences and the next
 * upcoming one of each maintenance (`getActiveMaintenanceForStatusPage`), in the page's order.
 */
export async function announcedMaintenance(
  payload: Payload,
  page: Pick<StatusPage, 'id' | 'maintenanceVisibilityHours'>,
  events: readonly MaintenanceEvent[],
  now: Date = new Date(),
): Promise<MaintenanceEvent[]> {
  const shown = await getActiveMaintenanceForStatusPage(payload, page.id, {
    now,
    visibilityHours: page.maintenanceVisibilityHours,
  })
  const byId = new Map(events.map((e) => [e.id, e]))
  return shown.flatMap((item) => {
    const event = byId.get(item.id)
    return event && !isFinishedState(event.state) ? [event] : []
  })
}
