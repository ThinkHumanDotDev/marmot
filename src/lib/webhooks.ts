/**
 * Shapes and constants of outbound webhooks (#157) shared by the collections, the route handlers
 * and the settings UI. Free of server imports.
 */

/**
 * - `pending`: queued, not attempted yet;
 * - `retrying`: the last attempt failed, another one is scheduled;
 * - `succeeded`: the receiver answered 2xx;
 * - `failed`: failed for good (non-retryable answer or retries exhausted);
 * - `cancelled`: dropped because the endpoint was disabled or deleted before delivery.
 */
export const WEBHOOK_DELIVERY_STATES = [
  'pending',
  'retrying',
  'succeeded',
  'failed',
  'cancelled',
] as const
export type WebhookDeliveryState = (typeof WEBHOOK_DELIVERY_STATES)[number]

/** Why a delivery exists: an event, a manual redelivery from the log, or "Send test event". */
export const WEBHOOK_DELIVERY_TRIGGERS = ['event', 'redelivery', 'test'] as const
export type WebhookDeliveryTrigger = (typeof WEBHOOK_DELIVERY_TRIGGERS)[number]

/** Value of `X-Marmot-Webhook-Version`; bumped on incompatible envelope changes. */
export const WEBHOOK_PAYLOAD_VERSION = '1'

/** Characters of the response body kept in the delivery log. */
export const WEBHOOK_RESPONSE_SNIPPET_LENGTH = 2048

/** What the settings UI receives for an endpoint (never the secret). */
export interface WebhookEndpointRow {
  id: string
  url: string
  description: string | null
  events: string[]
  active: boolean
  /** `failures` when the worker disabled it after too many failed deliveries. */
  disabledReason: 'failures' | null
  disabledAt: string | null
  consecutiveFailures: number
  lastDeliveryAt: string | null
  lastDeliveryState: 'succeeded' | 'failed' | null
  /** A rotation is in progress: the previous secret still signs until then. */
  previousSecretExpiresAt: string | null
  createdAt: string
}

/** One row of the delivery log. */
export interface WebhookDeliveryRow {
  id: string
  endpointId: string
  eventId: string
  eventType: string
  trigger: WebhookDeliveryTrigger
  state: WebhookDeliveryState
  attempts: number
  body: unknown
  requestHeaders: Record<string, string> | null
  responseStatus: number | null
  responseHeaders: Record<string, string> | null
  responseBody: string | null
  durationMs: number | null
  error: string | null
  deliveredAt: string | null
  redeliveryOf: string | null
  createdAt: string
  updatedAt: string
}
