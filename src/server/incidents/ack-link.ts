/**
 * Signed acknowledge links for notification messages (#100).
 *
 * A DOWN notification (and every reminder) carries `<server>/ack/<token>`, where the token is
 * `base64url("<incidentId>.<expiry>")` plus an HMAC-SHA256 over it with a key derived from
 * `PAYLOAD_SECRET`. The link opens a confirmation page; the acknowledgement itself is a POST, so
 * chat link previews and mail scanners that fetch URLs cannot acknowledge. Whoever holds the message
 * may acknowledge (that is the point for on-call phones): a signed-in member is recorded by name,
 * everyone else as "via link". A token only ever acknowledges its own incident and expires after
 * `ACK_LINK_TTL_SECONDS`; acknowledging twice is refused, and nothing else (resolve, read) is allowed.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'

import { deriveKey } from '@/auth/two-factor/crypto'
import { env } from '@/env'

const PURPOSE = 'marmot:incident-ack'

export const ACK_LINK_TTL_SECONDS = 7 * 24 * 3600

const key = () => deriveKey(env.PAYLOAD_SECRET, PURPOSE)

const sign = (body: string) => createHmac('sha256', key()).update(body).digest('base64url')

/** Token for `incidentId`, valid `ACK_LINK_TTL_SECONDS` from `now`. */
export function signAckToken(incidentId: string | number, now: number = Date.now()): string {
  const expiry = Math.floor(now / 1000) + ACK_LINK_TTL_SECONDS
  const body = Buffer.from(`${incidentId}.${expiry}`, 'utf8').toString('base64url')
  return `${body}.${sign(body)}`
}

/** The incident id of a valid, unexpired token; `null` for anything else. */
export function verifyAckToken(
  token: string | null | undefined,
  now: number = Date.now(),
): { incidentId: string } | null {
  if (typeof token !== 'string' || token.length > 512) return null
  const [body, signature, extra] = token.split('.')
  if (!body || !signature || extra !== undefined) return null
  const expected = Buffer.from(sign(body))
  const given = Buffer.from(signature)
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null
  const decoded = Buffer.from(body, 'base64url').toString('utf8')
  const dot = decoded.lastIndexOf('.')
  if (dot <= 0) return null
  const incidentId = decoded.slice(0, dot)
  const expiry = Number(decoded.slice(dot + 1))
  if (!Number.isFinite(expiry) || expiry * 1000 < now) return null
  return { incidentId }
}

/** Absolute URL of the acknowledge page for an incident. */
export function ackLinkUrl(incidentId: string | number, now: number = Date.now()): string {
  return `${env.NEXT_PUBLIC_SERVER_URL.replace(/\/$/, '')}/ack/${signAckToken(incidentId, now)}`
}
