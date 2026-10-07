/** Serialisation of endpoints and deliveries for the API and the settings UI (never the secret). */
import type { WebhookDeliveryRow, WebhookEndpointRow } from '@/lib/webhooks'
import type { WebhookDelivery, WebhookEndpoint } from '@/payload-types'

const relString = (value: unknown): string | null => {
  if (value === null || value === undefined) return null
  if (typeof value === 'object') {
    const id = (value as { id?: unknown }).id
    return id === undefined || id === null ? null : String(id)
  }
  return String(value)
}

const stringRecord = (value: unknown): Record<string, string> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).map(([key, v]) => [key, String(v)]))
    : null

export function toEndpointRow(doc: WebhookEndpoint): WebhookEndpointRow {
  return {
    id: String(doc.id),
    url: doc.url,
    description: doc.description ?? null,
    events: Array.isArray(doc.events)
      ? (doc.events as unknown[]).filter((e): e is string => typeof e === 'string')
      : [],
    active: doc.active !== false,
    disabledReason: doc.disabledReason === 'failures' ? 'failures' : null,
    disabledAt: doc.disabledAt ?? null,
    consecutiveFailures: doc.consecutiveFailures ?? 0,
    lastDeliveryAt: doc.lastDeliveryAt ?? null,
    lastDeliveryState: doc.lastDeliveryState ?? null,
    previousSecretExpiresAt:
      doc.previousSecretExpiresAt && new Date(doc.previousSecretExpiresAt).getTime() > Date.now()
        ? doc.previousSecretExpiresAt
        : null,
    createdAt: doc.createdAt,
  }
}

export function toDeliveryRow(doc: WebhookDelivery): WebhookDeliveryRow {
  return {
    id: String(doc.id),
    endpointId: relString(doc.endpoint) ?? '',
    eventId: doc.eventId,
    eventType: doc.eventType,
    trigger: doc.trigger,
    state: doc.state,
    attempts: doc.attempts ?? 0,
    body: doc.body,
    requestHeaders: stringRecord(doc.requestHeaders),
    responseStatus: doc.responseStatus ?? null,
    responseHeaders: stringRecord(doc.responseHeaders),
    responseBody: doc.responseBody ?? null,
    durationMs: doc.durationMs ?? null,
    error: doc.error ?? null,
    deliveredAt: doc.deliveredAt ?? null,
    redeliveryOf: relString(doc.redeliveryOf),
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  }
}
