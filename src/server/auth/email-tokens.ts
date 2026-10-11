/**
 * Single-use tokens sent to a user's email address: the plumbing behind email verification (#177)
 * and meant to be reused by passwordless sign-in links (#164).
 *
 * - A token is 256 random bits (`base64url`, 43 characters). Only its SHA-256 digest is stored, in
 *   Redis under `marmot:auth-token:<purpose>:<digest>` with the user id and the address it was
 *   sent to, and it expires on its own (`ttlSeconds`).
 * - Tokens are bound to a `purpose`: a verification token can never be redeemed as anything else.
 * - Issuing a token for a user and purpose revokes the one issued before (only the newest link in
 *   the inbox works). Tokens for an address without an account (`magic-link-signup`) use a stable
 *   pseudo user id derived from the address (`addressTokenSubject`).
 * - `consumeEmailToken` reads and deletes the entry in one `MULTI`, so a token is redeemed at most
 *   once even when two requests race, on every database adapter (no transactions involved).
 * - The address travels with the token: callers compare it with the user's current address, so a
 *   link sent before an email change cannot confirm the new address.
 */
import { createHash, randomBytes } from 'node:crypto'

import type { Redis } from 'ioredis'

import { childLogger } from '@/lib/logger'
import { createRedis } from '@/server/redis'

const log = childLogger('email-tokens')

/**
 * What a token proves. `magic-link` signs an existing account in, `magic-link-signup` creates the
 * account for an address that has none yet (#164).
 */
export const EMAIL_TOKEN_PURPOSES = [
  'email-verification',
  'magic-link',
  'magic-link-signup',
] as const
export type EmailTokenPurpose = (typeof EMAIL_TOKEN_PURPOSES)[number]

const KEY_PREFIX = 'marmot:auth-token'
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/

let store: Redis | undefined

const getStore = (): Redis => {
  store ??= createRedis({ maxRetriesPerRequest: 1, commandTimeout: 2_000 })
  return store
}

/** Closes the token store connection (tests, graceful shutdown). */
export async function closeEmailTokenStore(): Promise<void> {
  const client = store
  store = undefined
  if (client) await client.quit().catch(() => undefined)
}

const digest = (value: string) => createHash('sha256').update(value).digest('base64url')
const tokenKey = (purpose: EmailTokenPurpose, hash: string) => `${KEY_PREFIX}:${purpose}:${hash}`
/** Points at the digest of the user's newest token of a purpose, so issuing revokes the previous. */
const latestKey = (purpose: EmailTokenPurpose, userId: string | number) =>
  `${KEY_PREFIX}:${purpose}:user:${String(userId)}`

interface StoredToken {
  /** User id (string, whatever the adapter's id type). */
  u: string
  /** Normalized address the token was sent to. */
  e: string
  /** Issued at, epoch milliseconds. */
  i: number
}

export interface IssuedEmailToken {
  /** The plaintext token; put it in the link and forget it. */
  token: string
  expiresAt: Date
}

export interface RedeemedEmailToken {
  userId: string
  email: string
  issuedAt: Date
}

export const normalizeTokenEmail = (email: string): string => email.trim().toLowerCase()

/**
 * Stand-in for the user id of a token sent to an address that has no account yet, so issuing a new
 * one still revokes the previous link to the same address. Never a real id (it contains `:`).
 */
export const addressTokenSubject = (email: string): string =>
  `address:${digest(normalizeTokenEmail(email))}`

/** `true` for strings shaped like a token (cheap check before touching Redis). */
export const isEmailTokenShape = (value: unknown): value is string =>
  typeof value === 'string' && TOKEN_PATTERN.test(value)

/**
 * Mints a token for `userId` and `email`, valid for `ttlSeconds`, and revokes the user's previous
 * token of the same purpose. Throws when Redis is unreachable (the caller decides whether that
 * fails the request or is only logged).
 */
export async function issueEmailToken({
  purpose,
  userId,
  email,
  ttlSeconds,
}: {
  purpose: EmailTokenPurpose
  userId: string | number
  email: string
  ttlSeconds: number
}): Promise<IssuedEmailToken> {
  const token = randomBytes(32).toString('base64url')
  const hash = digest(token)
  const entry: StoredToken = { u: String(userId), e: normalizeTokenEmail(email), i: Date.now() }
  const redis = getStore()
  const previous = await redis.get(latestKey(purpose, userId))
  const multi = redis
    .multi()
    .set(tokenKey(purpose, hash), JSON.stringify(entry), 'EX', ttlSeconds)
    .set(latestKey(purpose, userId), hash, 'EX', ttlSeconds)
  if (previous && previous !== hash) multi.del(tokenKey(purpose, previous))
  await multi.exec()
  return { token, expiresAt: new Date(entry.i + ttlSeconds * 1000) }
}

/**
 * Redeems a token: returns who it was issued to and deletes it, or `null` when it is malformed,
 * unknown, expired, already used, issued for another purpose, or Redis cannot be reached.
 */
export async function consumeEmailToken({
  purpose,
  token,
}: {
  purpose: EmailTokenPurpose
  token: unknown
}): Promise<RedeemedEmailToken | null> {
  if (!isEmailTokenShape(token)) return null
  const hash = digest(token)
  let raw: string | null = null
  try {
    const result = await getStore()
      .multi()
      .get(tokenKey(purpose, hash))
      .del(tokenKey(purpose, hash))
      .exec()
    const value = result?.[0]?.[1]
    raw = typeof value === 'string' ? value : null
  } catch (err) {
    log.error({ err, purpose }, 'cannot read email token')
    return null
  }
  if (!raw) return null
  try {
    const entry = JSON.parse(raw) as Partial<StoredToken>
    if (typeof entry.u !== 'string' || typeof entry.e !== 'string') return null
    return { userId: entry.u, email: entry.e, issuedAt: new Date(entry.i ?? 0) }
  } catch {
    return null
  }
}

/** Revokes the user's outstanding token of `purpose` (after an email change, account deletion…). */
export async function revokeEmailTokens(
  purpose: EmailTokenPurpose,
  userId: string | number,
): Promise<void> {
  try {
    const redis = getStore()
    const previous = await redis.get(latestKey(purpose, userId))
    const multi = redis.multi().del(latestKey(purpose, userId))
    if (previous) multi.del(tokenKey(purpose, previous))
    await multi.exec()
  } catch (err) {
    log.warn({ err, purpose }, 'cannot revoke email tokens')
  }
}
