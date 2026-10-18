/**
 * Slack request signing (#129, https://api.slack.com/authentication/verifying-requests-from-slack).
 *
 * Every request Slack sends (slash commands, interactivity, events) carries
 * `X-Slack-Request-Timestamp` and `X-Slack-Signature: v0=<hex>`, the HMAC-SHA256 of
 * `v0:<timestamp>:<raw body>` with the app's signing secret. A request is accepted only when the
 * signature matches (constant-time comparison) and the timestamp is within five minutes of now, so
 * a captured request cannot be replayed later.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'

/** How far the request timestamp may be from the server clock, in seconds. */
export const SLACK_SIGNATURE_MAX_AGE_SECONDS = 5 * 60

/** Largest request body read from Slack (commands and interactions are a few KB). */
export const SLACK_MAX_BODY_BYTES = 256 * 1024

export type SlackSignatureFailure = 'missing' | 'stale' | 'mismatch'

/** `v0=<hex>` for `body` sent at `timestamp` (seconds). Exported for tests and tooling. */
export function slackSignature(secret: string, timestamp: string | number, body: string): string {
  return `v0=${createHmac('sha256', secret).update(`v0:${timestamp}:${body}`).digest('hex')}`
}

/** Checks the signature headers of a Slack request; `null` when it is genuine. */
export function verifySlackSignature(
  secret: string,
  headers: Headers,
  body: string,
  now: number = Date.now(),
): SlackSignatureFailure | null {
  const timestamp = headers.get('x-slack-request-timestamp')
  const signature = headers.get('x-slack-signature')
  if (!timestamp || !signature || !/^\d{1,12}$/.test(timestamp)) return 'missing'
  if (Math.abs(Math.floor(now / 1000) - Number(timestamp)) > SLACK_SIGNATURE_MAX_AGE_SECONDS) {
    return 'stale'
  }
  const expected = Buffer.from(slackSignature(secret, timestamp, body))
  const given = Buffer.from(signature)
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return 'mismatch'
  return null
}
