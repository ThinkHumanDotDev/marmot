/**
 * Secrets of the Slack app (#129).
 *
 * - **Bot tokens** are sealed at rest with AES-256-GCM and a key derived from `PAYLOAD_SECRET` for
 *   the purpose `marmot:slack-bot-token`, the same scheme as TOTP secrets, single sign-on client
 *   secrets and SSH tunnel credentials (`src/auth/two-factor/crypto.ts`). The field is never
 *   readable through the API.
 * - **OAuth state** binds an install to the organization, the member who started it and a nonce
 *   kept in an HttpOnly cookie of their browser, so a forged callback cannot attach a workspace to
 *   somebody else's organization. Valid for ten minutes.
 * - **Link tokens** carry a Slack workspace and user to the `/slack/link/<token>` page, where a
 *   signed-in member confirms the link. Valid for fifteen minutes.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

import { decryptSecret, deriveKey, encryptSecret } from '@/auth/two-factor/crypto'
import { env } from '@/env'

const BOT_TOKEN_PURPOSE = 'marmot:slack-bot-token'
const STATE_PURPOSE = 'marmot:slack-oauth-state'
const LINK_PURPOSE = 'marmot:slack-user-link'

export const OAUTH_STATE_TTL_SECONDS = 10 * 60
export const LINK_TOKEN_TTL_SECONDS = 15 * 60

/** Cookie holding the nonce of the install in progress. */
export const SLACK_STATE_COOKIE = 'marmot-slack-state'

export const sealBotToken = (plain: string): string =>
  encryptSecret(plain, env.PAYLOAD_SECRET, BOT_TOKEN_PURPOSE)

/** The plaintext bot token, or `null` when unset or sealed with another `PAYLOAD_SECRET`. */
export const openBotToken = (sealed: string | null | undefined): string | null =>
  decryptSecret(sealed, env.PAYLOAD_SECRET, BOT_TOKEN_PURPOSE)

function sign(purpose: string, body: string): string {
  return createHmac('sha256', deriveKey(env.PAYLOAD_SECRET, purpose))
    .update(body)
    .digest('base64url')
}

function seal(purpose: string, data: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(data), 'utf8').toString('base64url')
  return `${body}.${sign(purpose, body)}`
}

function unseal(
  purpose: string,
  token: string | null | undefined,
  now: number,
): Record<string, unknown> | null {
  if (typeof token !== 'string' || token.length > 2048) return null
  const [body, signature, extra] = token.split('.')
  if (!body || !signature || extra !== undefined) return null
  const expected = Buffer.from(sign(purpose, body))
  const given = Buffer.from(signature)
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null
  try {
    const data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as unknown
    if (!data || typeof data !== 'object') return null
    const record = data as Record<string, unknown>
    if (typeof record.e !== 'number' || record.e * 1000 < now) return null
    return record
  } catch {
    return null
  }
}

export interface OAuthState {
  orgId: string
  userId: string
  nonce: string
}

/** A fresh state for an install started by `userId` in `orgId`, and the nonce for the cookie. */
export function createOAuthState(
  orgId: string | number,
  userId: string | number,
  now: number = Date.now(),
): { state: string; nonce: string } {
  const nonce = randomBytes(16).toString('base64url')
  const state = seal(STATE_PURPOSE, {
    o: String(orgId),
    u: String(userId),
    n: nonce,
    e: Math.floor(now / 1000) + OAUTH_STATE_TTL_SECONDS,
  })
  return { state, nonce }
}

export function verifyOAuthState(
  state: string | null | undefined,
  now: number = Date.now(),
): OAuthState | null {
  const data = unseal(STATE_PURPOSE, state, now)
  if (!data || typeof data.o !== 'string' || typeof data.u !== 'string') return null
  if (typeof data.n !== 'string') return null
  return { orgId: data.o, userId: data.u, nonce: data.n }
}

export interface LinkClaim {
  teamId: string
  slackUserId: string
}

export function createLinkToken(claim: LinkClaim, now: number = Date.now()): string {
  return seal(LINK_PURPOSE, {
    t: claim.teamId,
    s: claim.slackUserId,
    e: Math.floor(now / 1000) + LINK_TOKEN_TTL_SECONDS,
  })
}

export function verifyLinkToken(
  token: string | null | undefined,
  now: number = Date.now(),
): LinkClaim | null {
  const data = unseal(LINK_PURPOSE, token, now)
  if (!data || typeof data.t !== 'string' || typeof data.s !== 'string') return null
  return { teamId: data.t, slackUserId: data.s }
}
