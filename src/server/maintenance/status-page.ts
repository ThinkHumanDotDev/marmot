/**
 * Maintenance entries for public status pages (Uptime Kuma `StatusPage.getMaintenanceList`, MIT,
 * see THIRD_PARTY_NOTICES.md). Kuma lists only running maintenances; Marmot announces each
 * occurrence (#154) with its update timeline:
 *
 * - running occurrences (`in-progress`, `verifying`),
 * - the next `scheduled` occurrence of a maintenance that is not running, when it starts within
 *   `UPCOMING_DAYS` (or is already due but waits for an admin to start it),
 * - `completed` and `cancelled` occurrences for `visibilityHours` after they finished (the page's
 *   `maintenanceVisibilityHours`, default 24); after that they belong to the history page (#107).
 *
 * Everything is read from the persisted occurrences; nothing is computed from the schedule here.
 */
import type { Payload } from 'payload'

import {
  DEFAULT_MAINTENANCE_VISIBILITY_HOURS,
  isFinishedState,
  isOpenState,
  UNFINISHED_OCCURRENCE_STATES,
  type OccurrenceState,
  type OccurrenceUpdate,
} from '@/lib/maintenance-announcements'
import type { MaintenanceStrategy } from '@/lib/validation/maintenance'
import type { Maintenance, MaintenanceOccurrence } from '@/payload-types'
import { publicIdOf } from '@/server/status-pages/public-ids'
import { toOccurrenceUpdate } from './occurrences'
import { relationId } from './serialize'
import { resolveTimezone } from './status'
import { getOrganizationTimezone } from './timezone'

export const UPCOMING_DAYS = 7

export type PublicMaintenanceStatus = 'under-maintenance' | 'scheduled' | 'completed' | 'cancelled'

export interface PublicMaintenance {
  /** Occurrence id (a maintenance can have a finished and an upcoming occurrence listed). */
  id: string
  /** Short id of the permalink (`<page>/events/maintenance/<publicId>`). */
  publicId: string
  maintenanceId: string
  title: string
  description: string | null
  strategy: MaintenanceStrategy
  /** Coarse status; `under-maintenance` while the occurrence is in progress or verifying. */
  status: PublicMaintenanceStatus
  /** Lifecycle state of the occurrence. */
  state: OccurrenceState
  /** ISO planned start. */
  start: string | null
  /** ISO planned end; null when open-ended (manual maintenances). */
  end: string | null
  startedAt: string | null
  completedAt: string | null
  cancelledAt: string | null
  /** IANA zone the window was planned in (for display). */
  timezone: string
  /** Timeline, newest first. */
  updates: OccurrenceUpdate[]
}

export interface PublicMaintenanceOptions {
  now?: Date
  /** Hours finished occurrences stay listed (default 24). */
  visibilityHours?: number | null
}

const HOUR_MS = 60 * 60_000

const ms = (value: string | null | undefined): number =>
  value ? new Date(value).getTime() : Number.NaN

const publicStatus = (state: OccurrenceState): PublicMaintenanceStatus =>
  isOpenState(state)
    ? 'under-maintenance'
    : state === 'completed' || state === 'cancelled'
      ? state
      : 'scheduled'

const ORDER: Record<PublicMaintenanceStatus, number> = {
  'under-maintenance': 0,
  scheduled: 1,
  completed: 2,
  cancelled: 2,
}

/** Public view of one occurrence of `doc`; `timezone` is the zone the window was planned in. */
export function toPublicMaintenance(
  doc: Maintenance,
  occurrence: MaintenanceOccurrence,
  timezone: string,
): PublicMaintenance {
  return {
    id: String(occurrence.id),
    publicId: publicIdOf('maintenance-occurrences', occurrence),
    maintenanceId: String(doc.id),
    title: doc.title,
    description: doc.description ?? null,
    strategy: doc.strategy,
    status: publicStatus(occurrence.state),
    state: occurrence.state,
    start: occurrence.start ?? null,
    end: occurrence.end ?? null,
    startedAt: occurrence.startedAt ?? null,
    completedAt: occurrence.completedAt ?? null,
    cancelledAt: occurrence.cancelledAt ?? null,
    timezone,
    updates: (occurrence.updates ?? []).map(toOccurrenceUpdate).reverse(),
  }
}

/** The zone a maintenance's windows are planned in (its own, else the organization's). */
export async function maintenanceTimezone(payload: Payload, doc: Maintenance): Promise<string> {
  const serverTimezone = await getOrganizationTimezone(payload, relationId(doc.organization))
  return resolveTimezone(doc.timezone, serverTimezone)
}

/** Maintenance entries of a status page: running first, then upcoming, then recently finished. */
export async function getActiveMaintenanceForStatusPage(
  payload: Payload,
  statusPageId: string | number,
  nowOrOptions: Date | PublicMaintenanceOptions = {},
): Promise<PublicMaintenance[]> {
  const options = nowOrOptions instanceof Date ? { now: nowOrOptions } : nowOrOptions
  const now = options.now ?? new Date()
  const visibilityHours = Math.max(
    0,
    options.visibilityHours ?? DEFAULT_MAINTENANCE_VISIBILITY_HOURS,
  )

  const { docs: maintenances } = await payload.find({
    collection: 'maintenance',
    where: { statusPages: { equals: statusPageId } },
    depth: 0,
    limit: 100,
    pagination: false,
    overrideAccess: true,
  })
  if (maintenances.length === 0) return []
  const byId = new Map((maintenances as Maintenance[]).map((m) => [String(m.id), m]))

  const finishedSinceMs = now.getTime() - visibilityHours * HOUR_MS
  const finishedSince = new Date(finishedSinceMs).toISOString()
  const horizon = now.getTime() + UPCOMING_DAYS * 24 * HOUR_MS
  const { docs: occurrences } = await payload.find({
    collection: 'maintenance-occurrences',
    where: {
      and: [
        { maintenance: { in: (maintenances as Maintenance[]).map((m) => m.id) } },
        {
          or: [
            { state: { in: [...UNFINISHED_OCCURRENCE_STATES] } },
            { completedAt: { greater_than_equal: finishedSince } },
            { cancelledAt: { greater_than_equal: finishedSince } },
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

  const running = new Set<string>()
  for (const occurrence of occurrences as MaintenanceOccurrence[]) {
    if (isOpenState(occurrence.state)) running.add(String(relationId(occurrence.maintenance)))
  }

  const zones = new Map<string, string>()
  const zoneOf = async (doc: Maintenance): Promise<string> => {
    const key = String(doc.id)
    const cached = zones.get(key)
    if (cached) return cached
    const zone = await maintenanceTimezone(payload, doc)
    zones.set(key, zone)
    return zone
  }

  const items: PublicMaintenance[] = []
  const upcomingListed = new Set<string>()
  for (const occurrence of occurrences as MaintenanceOccurrence[]) {
    const maintenanceId = String(relationId(occurrence.maintenance))
    const doc = byId.get(maintenanceId)
    if (!doc) continue
    const finished = isFinishedState(occurrence.state)
    if (finished) {
      const finishedAt = ms(occurrence.completedAt ?? occurrence.cancelledAt)
      if (!(finishedAt >= finishedSinceMs)) continue
    } else if (doc.active === false) {
      continue
    }
    if (occurrence.state === 'scheduled') {
      // One upcoming entry per maintenance, and none while it is running.
      if (running.has(maintenanceId) || upcomingListed.has(maintenanceId)) continue
      if (ms(occurrence.start) > horizon) continue
      upcomingListed.add(maintenanceId)
    }
    items.push(toPublicMaintenance(doc, occurrence, await zoneOf(doc)))
  }

  const finishedAt = (item: PublicMaintenance) => ms(item.completedAt ?? item.cancelledAt) || 0
  return items.sort((a, b) => {
    if (ORDER[a.status] !== ORDER[b.status]) return ORDER[a.status] - ORDER[b.status]
    // Recently finished: newest first; running and upcoming: earliest start first.
    if (ORDER[a.status] === 2) return finishedAt(b) - finishedAt(a)
    return (ms(a.start) || 0) - (ms(b.start) || 0)
  })
}
