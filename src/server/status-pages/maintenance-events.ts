/**
 * Maintenance of a status page as concrete events (one per window), for the machine-readable
 * outputs: the iCalendar feed, the Statuspage-compatible `scheduled_maintenances` and the Markdown
 * page. A recurring maintenance yields one event per occurrence with a stable id
 * (`<maintenance id>-<start, unix seconds>`); a single window keeps the maintenance id.
 */
import type { Payload } from 'payload'

import type { Maintenance } from '@/payload-types'
import { relationId } from '@/server/maintenance/serialize'
import { maintenanceWindowsBetween, resolveTimezone } from '@/server/maintenance/status'
import { getOrganizationTimezone } from '@/server/maintenance/timezone'

export type MaintenanceEventStatus = 'scheduled' | 'in_progress' | 'completed' | 'cancelled'

export interface MaintenanceEvent {
  /** Stable per occurrence. */
  id: string
  maintenanceId: string
  title: string
  description: string | null
  status: MaintenanceEventStatus
  /** ISO start; null for `manual` maintenance (running until switched off). */
  start: string | null
  /** ISO end; null for `manual` maintenance. */
  end: string | null
  /** IANA zone the window was planned in. */
  timezone: string
  /** Monitors the maintenance covers (string ids). */
  monitorIds: string[]
  createdAt: string
  updatedAt: string
  /** Revision for iCalendar `SEQUENCE`: seconds between creation and the last edit. */
  sequence: number
}

export interface MaintenanceEventOptions {
  now?: Date
  /** Window start (default: 30 days ago). */
  from?: Date
  /** Window end (default: 90 days ahead). */
  to?: Date
  /** Include upcoming windows of paused maintenance as `cancelled` (iCalendar). */
  includeCancelled?: boolean
}

const DAY_MS = 24 * 60 * 60_000
export const RECENT_DAYS = 30
export const AHEAD_DAYS = 90

export function maintenanceSequence(doc: Pick<Maintenance, 'createdAt' | 'updatedAt'>): number {
  const created = Date.parse(doc.createdAt)
  const updated = Date.parse(doc.updatedAt)
  if (Number.isNaN(created) || Number.isNaN(updated)) return 0
  return Math.max(0, Math.floor((updated - created) / 1000))
}

/** Events of every maintenance attached to the page, ordered by start (manual ones first). */
export async function listMaintenanceEvents(
  payload: Payload,
  pageId: string | number,
  options: MaintenanceEventOptions = {},
): Promise<MaintenanceEvent[]> {
  const now = options.now ?? new Date()
  const from = options.from ?? new Date(now.getTime() - RECENT_DAYS * DAY_MS)
  const to = options.to ?? new Date(now.getTime() + AHEAD_DAYS * DAY_MS)
  const { docs } = await payload.find({
    collection: 'maintenance',
    where: { statusPages: { equals: pageId } },
    depth: 0,
    limit: 100,
    pagination: false,
    sort: 'createdAt',
    overrideAccess: true,
  })

  const events: MaintenanceEvent[] = []
  for (const doc of docs as Maintenance[]) {
    const active = doc.active !== false
    const serverTimezone = await getOrganizationTimezone(payload, relationId(doc.organization))
    const base = {
      maintenanceId: String(doc.id),
      title: doc.title,
      description: doc.description?.trim() || null,
      timezone: resolveTimezone(doc.timezone, serverTimezone),
      monitorIds: (doc.monitors ?? [])
        .map(relationId)
        .filter((id) => id !== null)
        .map(String),
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
      sequence: maintenanceSequence(doc),
    }

    if (doc.strategy === 'manual') {
      if (active) {
        events.push({ ...base, id: String(doc.id), status: 'in_progress', start: null, end: null })
      }
      continue
    }

    const windows = maintenanceWindowsBetween(doc, from, to, { serverTimezone })
    for (const window of windows) {
      const start = Date.parse(window.start)
      const end = Date.parse(window.end)
      const nowMs = now.getTime()
      let status: MaintenanceEventStatus =
        end <= nowMs ? 'completed' : start <= nowMs ? 'in_progress' : 'scheduled'
      if (!active) {
        if (!options.includeCancelled || status === 'completed') continue
        status = 'cancelled'
      }
      events.push({
        ...base,
        id: doc.strategy === 'single' ? String(doc.id) : `${doc.id}-${Math.floor(start / 1000)}`,
        status,
        start: window.start,
        end: window.end,
      })
    }
  }

  return events.sort((a, b) => {
    const aStart = a.start ?? ''
    const bStart = b.start ?? ''
    if (aStart !== bStart) return aStart < bStart ? -1 : 1
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
}

/**
 * What the page announces: running windows, and the next window of each maintenance when it starts
 * within `horizonDays` (the public page uses 7).
 */
export function announcedMaintenance(
  events: readonly MaintenanceEvent[],
  now: Date = new Date(),
  horizonDays = 7,
): MaintenanceEvent[] {
  const horizon = now.getTime() + horizonDays * DAY_MS
  const seen = new Set<string>()
  const out: MaintenanceEvent[] = []
  for (const event of events) {
    if (event.status === 'in_progress') {
      seen.add(event.maintenanceId)
      out.push(event)
    } else if (
      event.status === 'scheduled' &&
      !seen.has(event.maintenanceId) &&
      event.start &&
      Date.parse(event.start) <= horizon
    ) {
      seen.add(event.maintenanceId)
      out.push(event)
    }
  }
  return out
}
