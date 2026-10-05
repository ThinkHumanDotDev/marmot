import { createHash } from 'node:crypto'

import { EncryptJWT, jwtDecrypt } from 'jose'

/**
 * Between a correct password and a correct code the login lives in a short-lived encrypted cookie
 * (same construction as the OIDC transaction cookie, `src/auth/oidc/state.ts`): a JWE keyed from
 * `PAYLOAD_SECRET` carrying the user id and the number of failed attempts. No session exists until
 * the code is verified, and the web process stays stateless.
 */

export const TWO_FACTOR_CHALLENGE_COOKIE = 'marmot-2fa'
export const TWO_FACTOR_CHALLENGE_TTL_SECONDS = 5 * 60
/** Only the auth endpoints ever need the cookie. */
export const TWO_FACTOR_CHALLENGE_COOKIE_PATH = '/api/auth'
/** Wrong codes allowed per challenge before the user has to enter their password again. */
export const TWO_FACTOR_MAX_ATTEMPTS = 5

export interface TwoFactorChallenge {
  userId: string
  attempts: number
}

const PURPOSE = 'marmot:2fa-challenge'

function deriveChallengeKey(secret: string): Uint8Array {
  return new Uint8Array(createHash('sha256').update(`${PURPOSE}:${secret}`).digest())
}

export async function sealChallenge(
  challenge: TwoFactorChallenge,
  secret: string,
  { ttlSeconds = TWO_FACTOR_CHALLENGE_TTL_SECONDS, now = Date.now() } = {},
): Promise<string> {
  const issuedAt = Math.floor(now / 1000)
  return new EncryptJWT({ u: challenge.userId, a: challenge.attempts })
    .setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
    .setSubject(PURPOSE)
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + ttlSeconds)
    .encrypt(deriveChallengeKey(secret))
}

/** `null` when missing, forged, expired or malformed. */
export async function openChallenge(
  token: string | null | undefined,
  secret: string,
  { now = Date.now() } = {},
): Promise<TwoFactorChallenge | null> {
  if (!token) return null
  try {
    const { payload } = await jwtDecrypt(token, deriveChallengeKey(secret), {
      subject: PURPOSE,
      currentDate: new Date(now),
    })
    const { u, a } = payload as Record<string, unknown>
    if (typeof u !== 'string' || u.length === 0) return null
    return { userId: u, attempts: typeof a === 'number' && a >= 0 ? a : 0 }
  } catch {
    return null
  }
}

interface CookieOptions {
  secure: boolean
}

const baseAttributes = ({ secure }: CookieOptions) =>
  `Path=${TWO_FACTOR_CHALLENGE_COOKIE_PATH}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`

export function challengeCookie(sealed: string, options: CookieOptions): string {
  return `${TWO_FACTOR_CHALLENGE_COOKIE}=${sealed}; Max-Age=${TWO_FACTOR_CHALLENGE_TTL_SECONDS}; ${baseAttributes(options)}`
}

export function clearChallengeCookie(options: CookieOptions): string {
  return `${TWO_FACTOR_CHALLENGE_COOKIE}=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; ${baseAttributes(options)}`
}
