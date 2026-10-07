/**
 * Signed subscriber links and SMS verification codes.
 *
 * A link token is `<subscriber id>.<signature>`, where the signature is an HMAC (keyed by
 * `PAYLOAD_SECRET`) of the id and the subscriber's random `token` field. Links therefore cannot be
 * forged or enumerated, survive without storing anything secret in the database, and all die at
 * once when the subscriber is deleted (or its `token` rotated).
 */
import { createHash, createHmac, randomInt, timingSafeEqual } from 'node:crypto'

import type { Payload } from 'payload'

import { env } from '@/env'
import { SMS_CODE_LENGTH } from '@/lib/status-page-subscribers'
import type { StatusPageSubscriber } from '@/payload-types'

const PURPOSE = 'marmot:status-page-subscriber'

const key = () => createHash('sha256').update(`${PURPOSE}:${env.PAYLOAD_SECRET}`).digest()

const sign = (value: string): string =>
  createHmac('sha256', key()).update(value).digest('base64url').slice(0, 32)

type TokenSource = Pick<StatusPageSubscriber, 'id'> & { token?: string | null }

/** The token of a subscriber's manage, confirm and unsubscribe links. */
export function subscriberLinkToken(subscriber: TokenSource): string {
  const id = String(subscriber.id)
  return `${id}.${sign(`link\0${id}\0${subscriber.token ?? ''}`)}`
}

/** Splits a link token; `null` when it is not shaped like one. */
export function parseSubscriberLinkToken(raw: unknown): { id: string; signature: string } | null {
  if (typeof raw !== 'string' || raw.length > 200) return null
  const match = /^([A-Za-z0-9_-]{1,64})\.([A-Za-z0-9_-]{32})$/.exec(raw)
  return match ? { id: match[1], signature: match[2] } : null
}

const sameString = (a: string, b: string): boolean => {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

/**
 * The subscriber a link token belongs to, or `null` for unknown, forged or revoked tokens. Loaded
 * with `overrideAccess` (links are anonymous), so callers must only expose what the link holder may
 * see: the subscription itself.
 */
export async function findSubscriberByLinkToken(
  payload: Payload,
  raw: unknown,
): Promise<StatusPageSubscriber | null> {
  const parsed = parseSubscriberLinkToken(raw)
  if (!parsed) return null
  const id = payload.db.defaultIDType === 'number' ? Number(parsed.id) : parsed.id
  if (typeof id === 'number' && !Number.isSafeInteger(id)) return null
  const subscriber = (await payload.findByID({
    collection: 'status-page-subscribers',
    id,
    depth: 0,
    overrideAccess: true,
    disableErrors: true,
  })) as StatusPageSubscriber | null
  if (!subscriber) return null
  return sameString(subscriberLinkToken(subscriber), `${parsed.id}.${parsed.signature}`)
    ? subscriber
    : null
}

/** A random numeric SMS code. */
export const generateSmsCode = (): string =>
  String(randomInt(0, 10 ** SMS_CODE_LENGTH)).padStart(SMS_CODE_LENGTH, '0')

/** Keyed digest of an SMS code, bound to the subscriber (a stolen row reveals nothing reusable). */
export const hashSmsCode = (subscriberId: string | number, code: string): string =>
  sign(`sms\0${String(subscriberId)}\0${code.trim()}`)

export const smsCodeMatches = (
  subscriberId: string | number,
  code: string,
  hash: string | null | undefined,
): boolean => Boolean(hash) && sameString(hashSmsCode(subscriberId, code), hash ?? '')

/** Opaque, non-reversible key for rate limits on a target (never the address itself). */
export const targetKey = (pageId: string | number, channel: string, target: string): string =>
  sign(`target\0${String(pageId)}\0${channel}\0${target}`)
