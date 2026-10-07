/**
 * Channel senders for subscriber messages. Each throws a `DeliveryError` that says whether a retry
 * can help: network errors, timeouts, HTTP 5xx and 429 can; other 4xx responses, a missing SMS
 * channel or an unsubscribed phone number cannot.
 */
import type { Payload } from 'payload'

import { childLogger } from '@/lib/logger'
import type { Notification, StatusPage, StatusPageSubscriber } from '@/payload-types'
import type { RenderedEmail } from '@/server/email/subscriber-emails'
import { subscriberEmailHeaders } from '@/server/email/subscriber-emails'
import { describeNetworkError } from '@/server/notification-providers/http'
import { sendNotification } from '@/server/notifications/send'
import { guardedFetch } from '@/server/security/outbound-guard'
import { webhookSignatureHeaders } from '@/server/webhooks/signature'

import type { SubscriptionLinks } from './links'

const log = childLogger('status-pages:subscribers:deliver')

/** Webhook and Slack requests give up after five seconds (#104). */
export const WEBHOOK_TIMEOUT_MS = 5_000

export type DeliveryErrorReason =
  'network' | 'http' | 'rate-limited' | 'refused' | 'no-sms-channel' | 'unsubscribed' | 'smtp'

export class DeliveryError extends Error {
  readonly retryable: boolean
  readonly reason: DeliveryErrorReason
  constructor(message: string, reason: DeliveryErrorReason, retryable: boolean) {
    super(message)
    this.name = 'DeliveryError'
    this.reason = reason
    this.retryable = retryable
  }
}

// ---------------------------------------------------------------------------------------------
// Email

export async function sendSubscriberEmail(
  payload: Payload,
  to: string,
  email: RenderedEmail,
  links: SubscriptionLinks | null,
): Promise<void> {
  try {
    await payload.sendEmail({
      to,
      subject: email.subject,
      text: email.text,
      html: email.html,
      ...(links ? { headers: subscriberEmailHeaders(links) } : {}),
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    // SMTP 5xx replies (unknown mailbox, policy rejection) will not change on a retry.
    const permanent = /\b5\d\d\b/.test(message) && !/\b4\d\d\b/.test(message)
    throw new DeliveryError(message, 'smtp', !permanent)
  }
}

// ---------------------------------------------------------------------------------------------
// SMS (through the page's Twilio notification channel)

/** Twilio error 21610: the recipient replied STOP; sending again is refused until they reply START. */
const TWILIO_UNSUBSCRIBED = /\b21610\b/

export async function loadSmsChannel(
  payload: Payload,
  page: Pick<StatusPage, 'subscriptions'>,
): Promise<Notification | null> {
  const ref = page.subscriptions?.smsChannel
  const id = ref && typeof ref === 'object' ? ref.id : ref
  if (id === null || id === undefined) return null
  const channel = (await payload.findByID({
    collection: 'notifications',
    id,
    depth: 0,
    overrideAccess: true,
    disableErrors: true,
  })) as Notification | null
  return channel && channel.type === 'twilio' ? channel : null
}

export async function sendSubscriberSms(
  payload: Payload,
  page: Pick<StatusPage, 'subscriptions' | 'organization'>,
  to: string,
  text: string,
): Promise<void> {
  const channel = await loadSmsChannel(payload, page)
  if (!channel) throw new DeliveryError('No SMS channel configured', 'no-sms-channel', false)
  const config = { ...(channel.config as Record<string, unknown>), toNumber: to }
  try {
    await sendNotification(
      payload,
      { type: 'twilio', config, organization: channel.organization, id: channel.id },
      { message: text, monitor: null, heartbeat: null },
    )
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (TWILIO_UNSUBSCRIBED.test(message)) {
      throw new DeliveryError(message, 'unsubscribed', false)
    }
    const status = /HTTP (\d{3})/.exec(message)?.[1]
    const code = status ? Number(status) : null
    const retryable = code === null || code >= 500 || code === 429
    throw new DeliveryError(message, code === null ? 'network' : 'http', retryable)
  }
}

// ---------------------------------------------------------------------------------------------
// Webhooks and Slack

export interface WebhookRequest {
  url: string
  body: unknown
  /** Signing secret (webhook subscribers); Slack and Discord messages are not signed. */
  secret?: string | null
  headers?: StatusPageSubscriber['headers']
  event: string
  deliveryId: string
}

/** POST JSON with a 5 s timeout, no redirects; classifies failures for the retry policy. */
export async function postSubscriberWebhook(request: WebhookRequest): Promise<number> {
  const raw = JSON.stringify(request.body)
  const headers: Record<string, string> = {}
  for (const row of request.headers ?? []) {
    if (row?.name) headers[row.name] = row.value ?? ''
  }
  Object.assign(headers, {
    'Content-Type': 'application/json',
    'User-Agent': 'Marmot-Webhooks/1',
    ...(request.secret
      ? webhookSignatureHeaders(request.secret, raw, {
          event: request.event,
          deliveryId: request.deliveryId,
        })
      : {}),
  })

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
    throw new DeliveryError(describeNetworkError(err), 'network', true)
  }
  // Drain the body so the connection can be reused.
  await response.text().catch(() => '')
  if (response.ok) return response.status
  const status = response.status
  if (status === 429) {
    throw new DeliveryError(`HTTP ${status}`, 'rate-limited', true)
  }
  if (status >= 500) throw new DeliveryError(`HTTP ${status}`, 'http', true)
  log.debug({ status }, 'webhook refused')
  throw new DeliveryError(`HTTP ${status}`, 'refused', false)
}
