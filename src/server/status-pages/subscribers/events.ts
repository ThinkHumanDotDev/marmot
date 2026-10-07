/**
 * Turns incident updates (`onIncidentUpdatePosted`) and maintenance events
 * (`registerMaintenanceEventListener`) into subscriber notifications. Registered once per process
 * from Payload's `onInit` (web, worker and realtime alike): incidents are posted in the web process,
 * maintenance transitions happen in both. Raw monitor alerts never reach subscribers.
 */
import type { Payload } from 'payload'

import { afterCommit } from '@/db/after-commit'
import { childLogger } from '@/lib/logger'
import type { NotificationEvent } from '@/lib/status-page-subscribers'
import type { StatusPage } from '@/payload-types'
import {
  registerMaintenanceEventListener,
  type MaintenanceEvent,
  type MaintenanceEventType,
} from '@/server/maintenance/events'
import {
  onIncidentUpdatePosted,
  type IncidentUpdatePostedEvent,
} from '@/server/status-pages/incident-events'

import { createNotificationBatch } from './batches'

const log = childLogger('status-pages:subscribers:events')

const relId = (value: unknown): string | number | null => {
  if (typeof value === 'string' || typeof value === 'number') return value
  if (value && typeof value === 'object' && 'id' in value) {
    const id = (value as { id: unknown }).id
    if (typeof id === 'string' || typeof id === 'number') return id
  }
  return null
}

/** Maintenance events carry string ids; Postgres relationships want numbers. */
const toId = (payload: Payload, id: string): string | number =>
  payload.db.defaultIDType === 'number' && /^\d+$/.test(id) ? Number(id) : id

async function loadPage(payload: Payload, id: string | number | null): Promise<StatusPage | null> {
  if (id === null) return null
  return (await payload.findByID({
    collection: 'status-pages',
    id,
    depth: 0,
    overrideAccess: true,
    disableErrors: true,
  })) as StatusPage | null
}

const INCIDENT_EVENTS: Record<IncidentUpdatePostedEvent['kind'], NotificationEvent> = {
  opened: 'incident_opened',
  updated: 'incident_updated',
  reopened: 'incident_updated',
  resolved: 'incident_resolved',
}

/** Every component the incident ever named: the announcement is "about" them. */
function incidentComponents(event: IncidentUpdatePostedEvent): string[] {
  const ids = new Set<string>()
  for (const row of event.incident.affectedComponents ?? []) {
    if (row?.component) ids.add(String(row.component))
  }
  for (const update of event.incident.updates ?? []) {
    for (const row of update.components ?? []) if (row?.component) ids.add(String(row.component))
  }
  return [...ids]
}

export async function announceIncidentUpdate(event: IncidentUpdatePostedEvent): Promise<void> {
  const { payload, incident, update } = event
  const page = await loadPage(payload, relId(incident.statusPage))
  if (!page) return
  await createNotificationBatch(payload, {
    page,
    event: INCIDENT_EVENTS[event.kind],
    dedupeKey: `incident:${page.id}:${incident.id}:${update.id}`,
    title: incident.title,
    status: update.status,
    message: update.message ?? '',
    components: incidentComponents(event),
    occurredAt: update.postedAt ?? new Date().toISOString(),
    incident: incident.id,
    incidentUpdateId: update.id ?? null,
  })
}

const MAINTENANCE_EVENTS: Record<MaintenanceEventType, NotificationEvent> = {
  scheduled: 'maintenance_scheduled',
  reminder: 'maintenance_reminder',
  started: 'maintenance_started',
  updated: 'maintenance_updated',
  completed: 'maintenance_completed',
  cancelled: 'maintenance_cancelled',
}

/** Components of `page` that show one of the maintenance's monitors. */
function maintenanceComponents(page: StatusPage, monitors: readonly string[]): string[] {
  const wanted = new Set(monitors.map(String))
  const ids: string[] = []
  for (const group of page.groups ?? []) {
    for (const row of group.monitors ?? []) {
      const monitor = row.type === 'static' ? null : relId(row.monitor)
      if (row.id && monitor !== null && wanted.has(String(monitor))) ids.push(String(row.id))
    }
  }
  return ids
}

export async function announceMaintenanceEvent(
  payload: Payload,
  event: MaintenanceEvent,
): Promise<void> {
  const suffix = event.update?.id ?? event.reminderMinutes ?? ''
  for (const pageId of event.maintenance.statusPages) {
    const page = await loadPage(payload, toId(payload, pageId))
    if (!page) continue
    await createNotificationBatch(payload, {
      page,
      event: MAINTENANCE_EVENTS[event.type],
      dedupeKey: `maintenance:${page.id}:${event.occurrence.id}:${event.type}:${suffix}`,
      title: event.maintenance.title,
      status: event.update?.status ?? event.occurrence.state,
      message:
        event.update?.message ||
        (event.type === 'scheduled' ? (event.maintenance.description ?? '') : ''),
      components: maintenanceComponents(page, event.maintenance.monitors),
      occurredAt: event.at,
      window: {
        start: event.occurrence.start,
        end: event.occurrence.end,
        reminderMinutes: event.reminderMinutes,
      },
      maintenance: toId(payload, event.maintenance.id),
      occurrence: toId(payload, event.occurrence.id),
    })
  }
}

let unsubscribe: (() => void) | null = null

/** Idempotent: hooks subscriber notifications into incident and maintenance events. */
export function registerSubscriberListeners(): () => void {
  if (unsubscribe) return unsubscribe
  const offIncident = onIncidentUpdatePosted(async (event) => {
    // The incident row is not visible to other connections before the write commits.
    await afterCommit(event.req, async () => {
      try {
        await announceIncidentUpdate(event)
      } catch (err) {
        log.error({ err, incident: event.incident.id }, 'cannot announce incident update')
      }
    })
  })
  const offMaintenance = registerMaintenanceEventListener(async (event, payload) => {
    try {
      await announceMaintenanceEvent(payload, event)
    } catch (err) {
      log.error({ err, occurrence: event.occurrence.id }, 'cannot announce maintenance event')
    }
  })
  unsubscribe = () => {
    offIncident()
    offMaintenance()
    unsubscribe = null
  }
  return unsubscribe
}
