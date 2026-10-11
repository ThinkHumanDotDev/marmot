/**
 * Sending outbound webhooks (#157): one signed POST per attempt, recorded in the delivery log
 * (`webhook-deliveries`), plus the endpoint bookkeeping (last delivery, failure streak) and the
 * automatic disable after `WEBHOOK_DISABLE_AFTER_FAILURES` deliveries in a row failed for good.
 *
 * Requests go through `guardedFetch`, so the outbound address guard (`MONITOR_DENY_PRIVATE_ADDRESSES`,
 * `MONITOR_DENY_CIDRS`) applies to every connection; redirects are not followed.
 *
 * Retry policy: network errors, timeouts, HTTP 5xx, 408 and 429 are retried with backoff (see
 * `./queue.ts`); other answers (3xx, 4xx) and blocked addresses fail at once.
 */
import type { Job } from 'bullmq'
import type { Payload } from 'payload'

import { env } from '@/env'
import { childLogger } from '@/lib/logger'
import {
  WEBHOOK_PAYLOAD_VERSION,
  WEBHOOK_RESPONSE_SNIPPET_LENGTH,
  type WebhookDeliveryState,
} from '@/lib/webhooks'
import type { WebhookDelivery, WebhookEndpoint } from '@/payload-types'
import { describeNetworkError } from '@/server/notification-providers/http'
import { isDemoMode } from '@/server/demo/config'
import { deliverToDemoSink } from '@/server/demo/sink'
import { findBlockedMessage, guardedFetch } from '@/server/security/outbound-guard'

import { notifyEndpointDisabled } from './disabled-email'
import { WEBHOOK_DELIVERY_ATTEMPTS, type WebhookDeliveryJobData } from './queue'
import { WEBHOOK_SIGNATURE_HEADER, webhookSignatureHeaders } from './signature'

const log = childLogger('webhooks:deliver')

/** A receiver has ten seconds to answer. */
export const WEBHOOK_TIMEOUT_MS = 10_000

/** How long the previous secret keeps signing after a rotation. */
export const SECRET_ROTATION_GRACE_MS = 24 * 3600 * 1000

export const WEBHOOK_USER_AGENT = `Marmot-Webhooks/${WEBHOOK_PAYLOAD_VERSION}`
export const WEBHOOK_VERSION_HEADER = 'X-Marmot-Webhook-Version'

/** What is POSTed: the event envelope. */
export interface WebhookEnvelope {
  id: string
  type: string
  createdAt: string
  orgId: string
  data: Record<string, unknown>
}

export interface AttemptResult {
  ok: boolean
  retryable: boolean
  status: number | null
  requestHeaders: Record<string, string>
  responseHeaders: Record<string, string> | null
  responseBody: string | null
  durationMs: number
  error: string | null
}

type EndpointSecrets = Pick<
  WebhookEndpoint,
  'secret' | 'previousSecret' | 'previousSecretExpiresAt'
>

/** Secrets that sign a delivery: the current one, plus the previous one during a rotation. */
export function signingSecrets(endpoint: EndpointSecrets, now: Date = new Date()): string[] {
  const secrets = endpoint.secret ? [endpoint.secret] : []
  const until = endpoint.previousSecretExpiresAt
    ? new Date(endpoint.previousSecretExpiresAt).getTime()
    : 0
  if (endpoint.previousSecret && until > now.getTime()) secrets.push(endpoint.previousSecret)
  return secrets
}

const SENSITIVE_HEADER = /cookie|authorization|token|secret|signature|api-?key/i

/** Request headers for the log: the signatures are replaced, the timestamp kept. */
function loggedRequestHeaders(headers: Record<string, string>): Record<string, string> {
  const copy = { ...headers }
  const signature = copy[WEBHOOK_SIGNATURE_HEADER]
  if (signature) {
    copy[WEBHOOK_SIGNATURE_HEADER] = signature
      .split(',')
      .map((part) => (part.startsWith('t=') ? part : part.replace(/=.*/, '=[redacted]')))
      .join(',')
  }
  return copy
}

function loggedResponseHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {}
  let count = 0
  headers.forEach((value, name) => {
    if (count++ >= 50) return
    out[name] = SENSITIVE_HEADER.test(name) ? '[redacted]' : value.slice(0, 500)
  })
  return out
}

/** The first `limit` characters of the body, without reading a huge body to the end. */
async function readSnippet(response: Response, limit: number): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) return ''
  const decoder = new TextDecoder()
  let text = ''
  try {
    while (text.length <= limit) {
      const { done, value } = await reader.read()
      if (done) break
      text += decoder.decode(value, { stream: true })
    }
  } catch {
    // A body that breaks off still leaves what was read.
  } finally {
    await reader.cancel().catch(() => undefined)
  }
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

/** One signed POST of `envelope` to `url`. Never throws. */
export async function postWebhook(request: {
  url: string
  envelope: WebhookEnvelope
  secrets: readonly string[]
  deliveryId: string
}): Promise<AttemptResult> {
  const raw = JSON.stringify(request.envelope)
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': WEBHOOK_USER_AGENT,
    [WEBHOOK_VERSION_HEADER]: WEBHOOK_PAYLOAD_VERSION,
    ...webhookSignatureHeaders(request.secrets, raw, {
      event: request.envelope.type,
      deliveryId: request.deliveryId,
    }),
  }
  const requestHeaders = loggedRequestHeaders(headers)
  // Demo mode (#159): the sink accepts the delivery; nothing is sent.
  if (isDemoMode()) {
    deliverToDemoSink('webhook', { event: request.envelope.type, deliveryId: request.deliveryId })
    return {
      ok: true,
      retryable: false,
      status: 202,
      requestHeaders,
      responseHeaders: null,
      responseBody: null,
      durationMs: 0,
      error: null,
    }
  }
  const started = performance.now()
  const elapsed = () => Math.round(performance.now() - started)

  let response: Response
  try {
    response = await guardedFetch(request.url, {
      method: 'POST',
      headers,
      body: raw,
      redirect: 'manual',
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    })
  } catch (err) {
    const blocked = findBlockedMessage(err)
    return {
      ok: false,
      retryable: !blocked,
      status: null,
      requestHeaders,
      responseHeaders: null,
      responseBody: null,
      durationMs: elapsed(),
      error: blocked ?? describeNetworkError(err),
    }
  }

  const responseBody = await readSnippet(response, WEBHOOK_RESPONSE_SNIPPET_LENGTH)
  const status = response.status
  const ok = status >= 200 && status < 300
  return {
    ok,
    retryable: !ok && (status >= 500 || status === 408 || status === 429),
    status,
    requestHeaders,
    responseHeaders: loggedResponseHeaders(response.headers),
    responseBody,
    durationMs: elapsed(),
    error: ok ? null : `HTTP ${status}`,
  }
}

const findOrNull = async <T>(fn: () => Promise<T>): Promise<T | null> => {
  try {
    return (await fn()) ?? null
  } catch {
    return null
  }
}

const relId = (value: unknown): string | number | null => {
  if (typeof value === 'string' || typeof value === 'number') return value
  if (value && typeof value === 'object' && 'id' in value) {
    const id = (value as { id: unknown }).id
    if (typeof id === 'string' || typeof id === 'number') return id
  }
  return null
}

const loadDelivery = (payload: Payload, id: string | number) =>
  findOrNull(
    () =>
      payload.findByID({
        collection: 'webhook-deliveries',
        id,
        depth: 0,
        overrideAccess: true,
      }) as Promise<WebhookDelivery>,
  )

const loadEndpoint = (payload: Payload, id: string | number | null) =>
  id === null
    ? Promise.resolve(null)
    : findOrNull(
        () =>
          payload.findByID({
            collection: 'webhook-endpoints',
            id,
            depth: 0,
            overrideAccess: true,
          }) as Promise<WebhookEndpoint>,
      )

async function updateDelivery(
  payload: Payload,
  id: string | number,
  data: Partial<WebhookDelivery>,
): Promise<WebhookDelivery> {
  return (await payload.update({
    collection: 'webhook-deliveries',
    id,
    data,
    depth: 0,
    overrideAccess: true,
  })) as WebhookDelivery
}

async function updateEndpoint(
  payload: Payload,
  id: string | number,
  data: Partial<WebhookEndpoint>,
): Promise<void> {
  try {
    await payload.update({
      collection: 'webhook-endpoints',
      id,
      data,
      depth: 0,
      overrideAccess: true,
    })
  } catch (err) {
    log.warn({ err, endpoint: id }, 'cannot update webhook endpoint bookkeeping')
  }
}

/** POSTs the logged delivery once and records the outcome on the row and the endpoint. */
async function attempt(
  payload: Payload,
  delivery: WebhookDelivery,
  endpoint: WebhookEndpoint,
  attemptNumber: number,
  final: (result: AttemptResult) => boolean,
): Promise<{ result: AttemptResult; doc: WebhookDelivery }> {
  const result = await postWebhook({
    url: endpoint.url,
    envelope: delivery.body as unknown as WebhookEnvelope,
    secrets: signingSecrets(endpoint),
    deliveryId: String(delivery.id),
  })
  const now = new Date().toISOString()
  const state: WebhookDeliveryState = result.ok
    ? 'succeeded'
    : final(result)
      ? 'failed'
      : 'retrying'
  const doc = await updateDelivery(payload, delivery.id, {
    state,
    attempts: attemptNumber,
    requestHeaders: result.requestHeaders,
    responseStatus: result.status,
    responseHeaders: result.responseHeaders,
    responseBody: result.responseBody,
    durationMs: result.durationMs,
    error: result.error,
    ...(result.ok ? { deliveredAt: now } : {}),
  })
  await updateEndpoint(payload, endpoint.id, {
    lastDeliveryAt: now,
    lastDeliveryState: result.ok ? 'succeeded' : 'failed',
    ...(result.ok && (endpoint.consecutiveFailures ?? 0) > 0 ? { consecutiveFailures: 0 } : {}),
  })
  log[result.ok ? 'debug' : 'warn'](
    {
      delivery: delivery.id,
      endpoint: endpoint.id,
      type: delivery.eventType,
      status: result.status,
      error: result.error,
      attempt: attemptNumber,
    },
    result.ok ? 'webhook delivered' : 'webhook attempt failed',
  )
  return { result, doc }
}

/**
 * A delivery of an event failed for good: extend the endpoint's failure streak and disable it (and
 * email the organization's admins) once the streak reaches `WEBHOOK_DISABLE_AFTER_FAILURES`.
 */
export async function recordFinalFailure(
  payload: Payload,
  endpointId: string | number,
  lastError: string | null,
  threshold: number = env.WEBHOOK_DISABLE_AFTER_FAILURES,
): Promise<{ disabled: boolean; failures: number }> {
  const endpoint = await loadEndpoint(payload, endpointId)
  if (!endpoint) return { disabled: false, failures: 0 }
  const failures = (endpoint.consecutiveFailures ?? 0) + 1
  const disable = threshold > 0 && failures >= threshold && endpoint.active !== false
  await updateEndpoint(payload, endpoint.id, {
    consecutiveFailures: failures,
    ...(disable
      ? { active: false, disabledReason: 'failures', disabledAt: new Date().toISOString() }
      : {}),
  })
  if (disable) {
    log.warn({ endpoint: endpoint.id, failures }, 'webhook endpoint disabled after failures')
    await notifyEndpointDisabled(payload, endpoint, { failures, lastError }).catch((err) =>
      log.error({ err, endpoint: endpoint.id }, 'cannot email admins about a disabled webhook'),
    )
  }
  return { disabled: disable, failures }
}

export type WebhookJobLike = Pick<Job<WebhookDeliveryJobData>, 'data'> &
  Partial<Pick<Job, 'id' | 'attemptsMade' | 'opts'>>

export interface WebhookJobResult {
  outcome: 'sent' | 'failed' | 'skipped' | 'cancelled'
  reason?: string
}

const FINISHED: readonly WebhookDeliveryState[] = ['succeeded', 'failed', 'cancelled']

/**
 * Processor of `webhook-delivery` jobs (the notifications worker routes them here). Throws while
 * another attempt can help so BullMQ retries with backoff; returns once the delivery is finished.
 */
export async function processWebhookDeliveryJob(
  payload: Payload,
  job: WebhookJobLike,
): Promise<WebhookJobResult> {
  const delivery = await loadDelivery(payload, job.data.deliveryId)
  if (!delivery) return { outcome: 'skipped', reason: 'delivery-not-found' }
  if (FINISHED.includes(delivery.state as WebhookDeliveryState)) {
    return { outcome: 'skipped', reason: delivery.state }
  }

  const endpoint = await loadEndpoint(payload, relId(delivery.endpoint))
  if (!endpoint || (delivery.trigger === 'event' && endpoint.active === false)) {
    await updateDelivery(payload, delivery.id, {
      state: 'cancelled',
      error: endpoint ? 'Endpoint disabled' : 'Endpoint deleted',
    })
    return { outcome: 'cancelled', reason: endpoint ? 'endpoint-disabled' : 'endpoint-deleted' }
  }

  const attemptNumber = (job.attemptsMade ?? 0) + 1
  const maxAttempts = job.opts?.attempts ?? WEBHOOK_DELIVERY_ATTEMPTS
  const isFinal = (result: AttemptResult) => !result.retryable || attemptNumber >= maxAttempts
  const { result } = await attempt(payload, delivery, endpoint, attemptNumber, isFinal)
  if (result.ok) return { outcome: 'sent' }
  if (!isFinal(result)) throw new Error(result.error ?? 'webhook delivery failed')

  if (delivery.trigger === 'event') {
    await recordFinalFailure(payload, endpoint.id, result.error)
  }
  // Nothing left to retry: the job ends (the log row says `failed`).
  return { outcome: 'failed', reason: result.error ?? undefined }
}

/**
 * Sends a logged delivery right away, once, without retries: "Send test event" and "Redeliver" in
 * the settings UI, so the result shows up immediately. Manual deliveries do not count towards the
 * automatic disable, and they also go to disabled endpoints (to check a fix before re-enabling).
 */
export async function deliverNow(
  payload: Payload,
  deliveryId: string | number,
): Promise<WebhookDelivery | null> {
  const delivery = await loadDelivery(payload, deliveryId)
  if (!delivery) return null
  const endpoint = await loadEndpoint(payload, relId(delivery.endpoint))
  if (!endpoint) {
    return updateDelivery(payload, delivery.id, { state: 'cancelled', error: 'Endpoint deleted' })
  }
  const { doc } = await attempt(payload, delivery, endpoint, 1, () => true)
  return doc
}
