/**
 * Event emission of outbound webhooks (#157). Four sources feed `emitWebhookEvent`, each after the
 * change is committed and in whichever process made it (web, worker or realtime; the listeners are
 * registered from Payload's `onInit`):
 *
 * - the audit bus (`onAuditEvent`): every resource event the audit log records (`monitor.created`,
 *   `member.role_changed`, …), with the audit row's redacted before/after values;
 * - heartbeats the state machine flagged for notification: `monitor.down|up|degraded`;
 * - posted incident updates: `incident.update_posted` plus `incident.opened|resolved|reopened`;
 * - maintenance events: `maintenance.scheduled|reminder|started|update_posted|completed|cancelled`.
 *
 * `emitWebhookEvent` writes one `pending` delivery per active endpoint of the organization that
 * subscribes to the type and enqueues its job; the worker sends it (`./deliver.ts`).
 */
import { randomUUID } from 'node:crypto'

import type { Payload } from 'payload'

import { afterCommit } from '@/db/after-commit'
import { childLogger } from '@/lib/logger'
import { isWebhookResourceEvent, webhookSubscribes } from '@/lib/webhook-events'
import type { WebhookDeliveryTrigger } from '@/lib/webhooks'
import type { WebhookDelivery, WebhookEndpoint } from '@/payload-types'
import { onAuditEvent, type AuditEventRecord } from '@/server/audit/bus'
import type { NotificationEvent } from '@/server/engine/beat'
import { registerHeartbeatListener, type HeartbeatEvent } from '@/server/engine/hooks'
import {
  registerMaintenanceEventListener,
  type MaintenanceEvent,
} from '@/server/maintenance/events'
import {
  onIncidentUpdatePosted,
  type IncidentUpdatePostedEvent,
} from '@/server/status-pages/incident-events'

import type { WebhookEnvelope } from './deliver'
import { enqueueWebhookJobs, webhookDeliveryJob } from './queue'
import { displayUrl } from './url'

const log = childLogger('webhooks:events')

type Id = string | number

const relId = (value: unknown): Id | null => {
  if (typeof value === 'string' || typeof value === 'number') return value
  if (value && typeof value === 'object' && 'id' in value) {
    const id = (value as { id: unknown }).id
    if (typeof id === 'string' || typeof id === 'number') return id
  }
  return null
}

/** Ids arrive as strings from events; Postgres relationships want numbers. */
export const toDocId = (payload: Payload, id: Id): Id =>
  payload.db.defaultIDType === 'number' && typeof id === 'string' && /^\d+$/.test(id)
    ? Number(id)
    : id

export const newEventId = (): string => `evt_${randomUUID().replace(/-/g, '')}`

export function buildEnvelope(input: {
  type: string
  orgId: Id
  data: Record<string, unknown>
  id?: string
  createdAt?: string
}): WebhookEnvelope {
  return {
    id: input.id ?? newEventId(),
    type: input.type,
    createdAt: input.createdAt ?? new Date().toISOString(),
    orgId: String(input.orgId),
    data: input.data,
  }
}

/** Writes a `pending` delivery of `envelope` to `endpoint`. */
export async function createDelivery(
  payload: Payload,
  endpoint: Pick<WebhookEndpoint, 'id' | 'organization'>,
  envelope: WebhookEnvelope,
  trigger: WebhookDeliveryTrigger,
  redeliveryOf: Id | null = null,
): Promise<WebhookDelivery> {
  return (await payload.create({
    collection: 'webhook-deliveries',
    data: {
      organization: relId(endpoint.organization) as WebhookDelivery['organization'],
      endpoint: endpoint.id as WebhookDelivery['endpoint'],
      eventId: envelope.id,
      eventType: envelope.type,
      trigger,
      state: 'pending',
      attempts: 0,
      body: envelope as unknown as WebhookDelivery['body'],
      ...(redeliveryOf !== null
        ? { redeliveryOf: redeliveryOf as WebhookDelivery['redeliveryOf'] }
        : {}),
    },
    depth: 0,
    overrideAccess: true,
  })) as WebhookDelivery
}

/**
 * Fans an event out to the organization's active endpoints that subscribe to its type. Returns the
 * number of deliveries queued. Never throws.
 */
export async function emitWebhookEvent(
  payload: Payload,
  input: { type: string; orgId: Id; data: Record<string, unknown>; createdAt?: string },
): Promise<number> {
  try {
    const { docs } = await payload.find({
      collection: 'webhook-endpoints',
      where: {
        and: [
          { organization: { equals: toDocId(payload, input.orgId) } },
          { active: { equals: true } },
        ],
      },
      depth: 0,
      limit: 0,
      pagination: false,
      overrideAccess: true,
      select: { organization: true, events: true },
    })
    const endpoints = (docs as WebhookEndpoint[]).filter((endpoint) =>
      webhookSubscribes(endpoint.events as unknown[] | null, input.type),
    )
    if (endpoints.length === 0) return 0

    const envelope = buildEnvelope(input)
    const deliveries = await Promise.all(
      endpoints.map((endpoint) => createDelivery(payload, endpoint, envelope, 'event')),
    )
    await enqueueWebhookJobs(deliveries.map((delivery) => webhookDeliveryJob(delivery.id)))
    log.debug({ type: input.type, deliveries: deliveries.length }, 'webhook event queued')
    return deliveries.length
  } catch (err) {
    log.error({ err, type: input.type }, 'cannot queue webhook event')
    return 0
  }
}

// ---------------------------------------------------------------------------------------------
// Event data per source

/** `data` of a resource event: the audit row without request metadata. */
export function auditEventData(event: AuditEventRecord): Record<string, unknown> {
  return {
    object: { type: event.entityType, id: event.entityId, label: event.entityLabel },
    actor: { type: event.actorType, id: event.actorId, label: event.actorLabel },
    changedFields: event.changedFields,
    previous: event.before,
    current: event.after,
    metadata: event.metadata,
    auditLogId: event.id,
  }
}

/**
 * Webhook type of a notifying beat: `down` and `up` as the engine names them; a `degraded`
 * transition is `monitor.degraded` when the monitor became degraded and `monitor.up` when it
 * recovered from degraded. Reminders are not webhook events.
 */
export function monitorEventType(
  event: NotificationEvent | null | undefined,
  status: string,
): string | null {
  if (event === 'down') return 'monitor.down'
  if (event === 'up') return 'monitor.up'
  if (event === 'degraded') return status === 'degraded' ? 'monitor.degraded' : 'monitor.up'
  return null
}

export function monitorEventData(event: HeartbeatEvent): Record<string, unknown> {
  const { monitor, heartbeat } = event
  const target = monitor as { url?: string | null; hostname?: string | null; port?: number | null }
  return {
    monitor: {
      id: String(monitor.id),
      name: monitor.name,
      type: monitor.type,
      url: displayUrl(target.url),
      hostname: target.hostname ?? null,
    },
    status: heartbeat.status,
    previousStatus: event.previousStatus ?? null,
    heartbeat: {
      id: String(heartbeat.id),
      time: heartbeat.time,
      msg: heartbeat.msg ?? null,
      ping: heartbeat.ping ?? null,
    },
  }
}

const INCIDENT_KIND_EVENTS: Record<IncidentUpdatePostedEvent['kind'], string | null> = {
  opened: 'incident.opened',
  updated: null,
  resolved: 'incident.resolved',
  reopened: 'incident.reopened',
}

export function incidentEventData(event: IncidentUpdatePostedEvent): Record<string, unknown> {
  const { incident, update } = event
  return {
    incident: {
      id: String(incident.id),
      publicId: incident.publicId ?? null,
      title: incident.title,
      status: incident.status ?? update.status,
      impact: incident.impact ?? null,
      statusPage: relId(incident.statusPage) === null ? null : String(relId(incident.statusPage)),
      resolvedAt: incident.resolvedAt ?? null,
    },
    update: {
      id: update.id ?? null,
      status: update.status,
      message: update.message ?? '',
      postedAt: update.postedAt,
      components: (update.components ?? []).map((row) => ({
        component: row.component,
        impact: row.impact,
      })),
    },
    previousStatus: event.previousStatus,
  }
}

const MAINTENANCE_EVENTS: Record<MaintenanceEvent['type'], string> = {
  scheduled: 'maintenance.scheduled',
  reminder: 'maintenance.reminder',
  started: 'maintenance.started',
  updated: 'maintenance.update_posted',
  completed: 'maintenance.completed',
  cancelled: 'maintenance.cancelled',
}

export function maintenanceEventData(event: MaintenanceEvent): Record<string, unknown> {
  const { updates: _updates, remindersSent: _reminders, ...occurrence } = event.occurrence
  return {
    maintenance: event.maintenance,
    occurrence,
    update: event.update,
    reminderMinutes: event.reminderMinutes,
  }
}

// ---------------------------------------------------------------------------------------------
// Listeners

let unsubscribe: (() => void) | null = null

/** Idempotent: subscribes webhooks to the audit bus, heartbeats, incidents and maintenance. */
export function registerWebhookListeners(): () => void {
  if (unsubscribe) return unsubscribe

  const offAudit = onAuditEvent(async (event, { payload }) => {
    if (!event.organization || !isWebhookResourceEvent(event.action)) return
    await emitWebhookEvent(payload, {
      type: event.action,
      orgId: event.organization,
      createdAt: event.createdAt,
      data: auditEventData(event),
    })
  })

  const offHeartbeat = registerHeartbeatListener(async (event) => {
    if (!event.notify) return
    const type = monitorEventType(event.notificationEvent, event.heartbeat.status)
    const orgId = event.organizationId ?? relId(event.monitor.organization)
    if (!type || orgId === null || orgId === undefined) return
    await emitWebhookEvent(event.payload, { type, orgId, data: monitorEventData(event) })
  })

  const offIncident = onIncidentUpdatePosted(async (event) => {
    const orgId = relId(event.incident.organization)
    if (orgId === null) return
    // The write is not visible to the worker before it commits.
    await afterCommit(event.req, async () => {
      const data = incidentEventData(event)
      const kindType = INCIDENT_KIND_EVENTS[event.kind]
      if (kindType) await emitWebhookEvent(event.payload, { type: kindType, orgId, data })
      await emitWebhookEvent(event.payload, { type: 'incident.update_posted', orgId, data })
    })
  })

  const offMaintenance = registerMaintenanceEventListener(async (event, payload) => {
    await emitWebhookEvent(payload, {
      type: MAINTENANCE_EVENTS[event.type],
      orgId: event.organizationId,
      createdAt: event.at,
      data: maintenanceEventData(event),
    })
  })

  unsubscribe = () => {
    offAudit()
    offHeartbeat()
    offIncident()
    offMaintenance()
    unsubscribe = null
  }
  return unsubscribe
}
