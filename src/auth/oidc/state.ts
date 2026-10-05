import { createHash } from 'node:crypto'

import { EncryptJWT, jwtDecrypt } from 'jose'

/**
 * The OIDC transaction (PKCE verifier, `state`, `nonce` and the post-login path) travels in a
 * short-lived encrypted cookie between `/login` and `/callback`, so the web process stays
 * stateless. The cookie is a JWE (`dir` + `A256GCM`) keyed from `PAYLOAD_SECRET`: nothing in it
 * is readable or forgeable by the browser.
 */

export const OIDC_STATE_COOKIE = 'marmot-oidc'
export const OIDC_STATE_TTL_SECONDS = 10 * 60
/** The cookie is only ever needed by the OIDC endpoints. */
export const OIDC_STATE_COOKIE_PATH = '/api/auth/oidc'

export interface OidcTransaction {
  state: string
  nonce: string
  codeVerifier: string
  /** Same-origin path to land on after a successful login (already passed `safeNextPath`). */
  next: string
}

const PURPOSE = 'marmot:oidc-state'

/** 256-bit key derived from the Payload secret, scoped to this purpose. */
export function deriveStateKey(secret: string): Uint8Array {
  return new Uint8Array(createHash('sha256').update(`${PURPOSE}:${secret}`).digest())
}

export async function sealTransaction(
  tx: OidcTransaction,
  secret: string,
  { ttlSeconds = OIDC_STATE_TTL_SECONDS, now = Date.now() } = {},
): Promise<string> {
  const issuedAt = Math.floor(now / 1000)
  return new EncryptJWT({ s: tx.state, n: tx.nonce, v: tx.codeVerifier, p: tx.next })
    .setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
    .setSubject(PURPOSE)
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + ttlSeconds)
    .encrypt(deriveStateKey(secret))
}

/** Decrypts a sealed transaction; `null` when it is missing, forged, expired or malformed. */
export async function openTransaction(
  token: string | null | undefined,
  secret: string,
  { now = Date.now() } = {},
): Promise<OidcTransaction | null> {
  if (!token) return null
  try {
    const { payload } = await jwtDecrypt(token, deriveStateKey(secret), {
      subject: PURPOSE,
      currentDate: new Date(now),
    })
    const { s, n, v, p } = payload as Record<string, unknown>
    if ([s, n, v, p].some((value) => typeof value !== 'string' || value.length === 0)) return null
    return { state: s as string, nonce: n as string, codeVerifier: v as string, next: p as string }
  } catch {
    return null
  }
}

interface CookieOptions {
  /** `true` when the public URL is https; adds the `Secure` attribute. */
  secure: boolean
}

const baseAttributes = ({ secure }: CookieOptions) =>
  `Path=${OIDC_STATE_COOKIE_PATH}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`

/**
 * `Set-Cookie` value carrying the sealed transaction. `SameSite=Lax` (not `Strict`) because the
 * callback is a top-level navigation initiated by the identity provider's redirect.
 */
export function stateCookie(sealed: string, options: CookieOptions): string {
  return `${OIDC_STATE_COOKIE}=${sealed}; Max-Age=${OIDC_STATE_TTL_SECONDS}; ${baseAttributes(options)}`
}

/** `Set-Cookie` value that removes the transaction cookie. */
export function clearStateCookie(options: CookieOptions): string {
  return `${OIDC_STATE_COOKIE}=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; ${baseAttributes(options)}`
}

/** Reads one cookie from a `Cookie` request header. */
export function readCookie(headers: Headers, name: string): string | undefined {
  const header = headers.get('cookie')
  if (!header) return undefined
  for (const pair of header.split(/; */)) {
    const index = pair.indexOf('=')
    if (index === -1) continue
    if (pair.slice(0, index).trim() === name) {
      const raw = pair.slice(index + 1)
      try {
        return decodeURIComponent(raw)
      } catch {
        return raw
      }
    }
  }
  return undefined
}
