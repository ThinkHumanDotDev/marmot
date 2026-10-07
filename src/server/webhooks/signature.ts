/**
 * Signing of outbound webhook deliveries. One scheme for every webhook Marmot sends: status page
 * subscribers (#104) today, organization-level outbound webhooks (#157) later, so receivers verify
 * them all the same way.
 *
 *   X-Marmot-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>
 *
 * The timestamp is part of the signed string so a captured request cannot be replayed later:
 * receivers reject signatures older than a few minutes (`verifyWebhookSignature` defaults to five).
 * Several `v1=` entries may appear during a secret rotation; any match is valid.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

export const WEBHOOK_SIGNATURE_HEADER = 'X-Marmot-Signature'
export const WEBHOOK_EVENT_HEADER = 'X-Marmot-Event'
export const WEBHOOK_DELIVERY_HEADER = 'X-Marmot-Delivery'
export const WEBHOOK_SIGNATURE_VERSION = 'v1'
export const DEFAULT_SIGNATURE_TOLERANCE_SECONDS = 5 * 60

/** Prefix of generated secrets, so they are recognisable in configuration and secret scanners. */
export const WEBHOOK_SECRET_PREFIX = 'whsec_'

/** A new random signing secret (`whsec_` + 32 random bytes, base64url). */
export const generateWebhookSecret = (): string =>
  `${WEBHOOK_SECRET_PREFIX}${randomBytes(32).toString('base64url')}`

const digest = (secret: string, timestamp: number, body: string): string =>
  createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')

/** The `X-Marmot-Signature` value for `body` (the exact bytes sent) at `timestamp` (unix seconds). */
export function signWebhookPayload(
  secret: string,
  body: string,
  timestamp: number = Math.floor(Date.now() / 1000),
): string {
  return `t=${timestamp},${WEBHOOK_SIGNATURE_VERSION}=${digest(secret, timestamp, body)}`
}

/** Headers to add to a signed delivery. */
export function webhookSignatureHeaders(
  secret: string,
  body: string,
  { event, deliveryId, timestamp }: { event: string; deliveryId: string; timestamp?: number },
): Record<string, string> {
  return {
    [WEBHOOK_SIGNATURE_HEADER]: signWebhookPayload(secret, body, timestamp),
    [WEBHOOK_EVENT_HEADER]: event,
    [WEBHOOK_DELIVERY_HEADER]: deliveryId,
  }
}

/**
 * Receiver-side check (used by tests and documented for integrators): the header must carry a
 * timestamp within `toleranceSeconds` of `now` and at least one matching `v1` signature.
 */
export function verifyWebhookSignature(
  secret: string,
  body: string,
  header: string | null | undefined,
  { now = Date.now(), toleranceSeconds = DEFAULT_SIGNATURE_TOLERANCE_SECONDS } = {},
): boolean {
  if (!header) return false
  let timestamp: number | null = null
  const signatures: string[] = []
  for (const part of header.split(',')) {
    const [key, value] = part.trim().split('=', 2)
    if (key === 't' && value && /^\d+$/.test(value)) timestamp = Number(value)
    else if (key === WEBHOOK_SIGNATURE_VERSION && value) signatures.push(value)
  }
  if (timestamp === null || signatures.length === 0) return false
  if (Math.abs(now / 1000 - timestamp) > toleranceSeconds) return false
  const expected = Buffer.from(digest(secret, timestamp, body), 'hex')
  return signatures.some((candidate) => {
    const given = Buffer.from(candidate, 'hex')
    return given.length === expected.length && timingSafeEqual(given, expected)
  })
}
