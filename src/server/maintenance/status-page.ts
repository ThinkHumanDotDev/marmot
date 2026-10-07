/**
 * Maintenance entries for public status pages (Uptime Kuma `StatusPage.getMaintenanceList`, MIT,
 * see THIRD_PARTY_NOTICES.md). Kuma lists only running maintenances; Marmot also announces
 * upcoming windows that start within `UPCOMING_DAYS` so visitors are warned ahead of time.
 */
import type { Payload } from 'payload'

import type { MaintenanceStrategy } from '@/lib/validation/maintenance'
import type { Maintenance } from '@/payload-types'
import { timeslotsFor } from './serialize'

export const UPCOMING_DAYS = 7

export interface PublicMaintenance {
  id: string
  title: string
  description: string | null
  strategy: MaintenanceStrategy
  status: 'under-maintenance' | 'scheduled'
  /** ISO start of the running (or next) window; null for `manual` maintenances. */
  start: string | null
  /** ISO end of that window; null when open-ended. */
  end: string | null
  /** IANA zone the window was planned in (for display). */
  timezone: string
}

/** Running and upcoming maintenances attached to the status page, running ones first. */
export async function getActiveMaintenanceForStatusPage(
  payload: Payload,
  statusPageId: string | number,
  now: Date = new Date(),
): Promise<PublicMaintenance[]> {
  const { docs } = await payload.find({
    collection: 'maintenance',
    where: { and: [{ active: { equals: true } }, { statusPages: { equals: statusPageId } }] },
    depth: 0,
    limit: 100,
    pagination: false,
    overrideAccess: true,
  })

  const horizon = now.getTime() + UPCOMING_DAYS * 24 * 60 * 60_000
  const items: PublicMaintenance[] = []
  for (const doc of docs as Maintenance[]) {
    const slots = await timeslotsFor(payload, doc, now)
    if (slots.status === 'under-maintenance') {
      items.push({
        id: String(doc.id),
        title: doc.title,
        description: doc.description ?? null,
        strategy: doc.strategy,
        status: 'under-maintenance',
        start: slots.current?.start ?? null,
        end: slots.current?.end ?? null,
        timezone: slots.timezone,
      })
    } else if (
      slots.status === 'scheduled' &&
      slots.next &&
      new Date(slots.next.start).getTime() <= horizon
    ) {
      items.push({
        id: String(doc.id),
        title: doc.title,
        description: doc.description ?? null,
        strategy: doc.strategy,
        status: 'scheduled',
        start: slots.next.start,
        end: slots.next.end,
        timezone: slots.timezone,
      })
    }
  }

  return items.sort((a, b) => {
    if (a.status !== b.status) return a.status === 'under-maintenance' ? -1 : 1
    // ISO timestamps: code-unit order is chronological and the same on every server.
    const aStart = a.start ?? ''
    const bStart = b.start ?? ''
    return aStart < bStart ? -1 : aStart > bStart ? 1 : 0
  })
}
