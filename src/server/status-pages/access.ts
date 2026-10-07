/**
 * Visitor access to status pages: the single check every public surface of a page runs (the HTML
 * page, `GET /api/status-pages/:slug/public`, the RSS feed, `manifest.json`, badges, and all of
 * those on custom domains).
 *
 * `checkStatusPageAccess` dispatches on the page's `access` mode through `ACCESS_STRATEGIES`; a mode
 * without a strategy is denied (fail closed). Modes that grant a session reuse the signed access
 * cookie below; its fingerprint covers the mode, so switching modes signs everyone out.
 *
 * Password mode: the visitor proves the password once (`POST /api/status-pages/:slug/access`, or
 * `?pw=` on machine endpoints) and gets an HttpOnly cookie named after the page, holding an HS256
 * JWT for that page id with a fingerprint of the current password hash. Changing the password
 * changes the fingerprint and ends every session. Every password check is rate limited per page
 * and client.
 *
 * Email-domain mode: the visitor redeems a one-time link (`magic-link.ts`) and gets the same cookie,
 * which also names their `status-page-viewers` row. Every request re-checks that row (not revoked)
 * and that the address's domain is still allowed.
 *
 * IP allow-list mode: no session; every request's client address (resolved through the `trustProxy`
 * instance setting, see `requestMeta`) must fall in one of the page's CIDR ranges. Without a
 * trusted address nobody is admitted.
 */
import { createHash, createHmac } from 'node:crypto'

import { jwtVerify, SignJWT } from 'jose'
import type { Payload } from 'payload'

import { cookiesAreSecure } from '@/auth/session'
import { env } from '@/env'
import { readCookie } from '@/i18n/locales'
import type { StatusPageAccessMode } from '@/lib/status-page-access'
import { verifyPassword } from '@/server/security/password-hash'
import { createRateLimiter, type RateLimiter } from '@/server/security/rate-limit'
import { requestMeta } from '@/server/security/request'
import { ipAllowListFor } from '@/server/status-pages/ip-allowlist'
import { isEmailAllowed, touchViewer } from '@/server/status-pages/magic-link'

import type { StatusPage } from '@/payload-types'
import { defaultLocale, type Locale } from '@/i18n/locales'
import { translateError, type ErrorKey } from '@/server/errors'

/** The fields of a page the access check reads (load the page with `overrideAccess: true`). */
export type AccessPage = Pick<
  StatusPage,
  'access' | 'passwordHash' | 'allowedEmailDomains' | 'allowedIpRanges'
> & {
  /** Numbers on Postgres, strings on MongoDB. */
  id: string | number
}

/** What the check looks at: headers (cookies, client address) and, optionally, the query string. */
export interface AccessRequest {
  headers: Headers
  searchParams?: URLSearchParams
}

export const accessRequestFrom = (request: Request): AccessRequest => ({
  headers: request.headers,
  searchParams: new URL(request.url).searchParams,
})

export interface AccessOptions {
  /**
   * Accept the password in the `pw` query parameter (feed readers, scripts, badges). Off for the
   * HTML page, where the login form sets the cookie instead.
   */
  acceptPasswordParam?: boolean
}

export type AccessGrant = 'public' | 'session' | 'password' | 'ip'
export type AccessDenial = 'login-required' | 'invalid-password' | 'rate-limited' | 'ip-not-allowed'

export type StatusPageAccessDecision =
  | {
      allowed: true
      via: AccessGrant
      /** The response depends on the visitor's credentials: never store it in a shared cache. */
      restricted: boolean
    }
  | { allowed: false; reason: AccessDenial; retryAfterSeconds?: number }

export interface AccessContext {
  payload: Payload
  page: AccessPage
  request: AccessRequest
  options: AccessOptions
}

export type AccessStrategy = (ctx: AccessContext) => Promise<StatusPageAccessDecision>

/** Query parameter for machine clients. It puts the secret in URLs and logs; see the docs. */
export const PASSWORD_PARAM = 'pw'

// ---------------------------------------------------------------------------------------------
// Rate limiting

/**
 * Wrong passwords per page and client IP; a blocked client waits five minutes. Without a trusted
 * client address (instance setting `trustProxy` off) all visitors of a page share the wider
 * page-wide bucket, which still caps guessing at a few attempts per minute.
 */
export const STATUS_PAGE_PASSWORD_RATE_LIMIT = { points: 10, duration: 60, blockDuration: 5 * 60 }
export const STATUS_PAGE_PASSWORD_PAGE_RATE_LIMIT = {
  points: 30,
  duration: 60,
  blockDuration: 5 * 60,
}

export const statusPagePasswordLimiter: RateLimiter = createRateLimiter(
  'status-page-password',
  STATUS_PAGE_PASSWORD_RATE_LIMIT,
)
export const statusPagePasswordPageLimiter: RateLimiter = createRateLimiter(
  'status-page-password-page',
  STATUS_PAGE_PASSWORD_PAGE_RATE_LIMIT,
)

// ---------------------------------------------------------------------------------------------
// Verification cache: `?pw=` clients poll; skip the scrypt work (and the rate limit) for a
// password that was correct moments ago. Keys are digests, never the password itself.

const VERIFIED_TTL_MS = 5 * 60 * 1000
const VERIFIED_MAX = 1_000
const verified = new Map<string, number>()

const verifiedKey = (page: AccessPage, password: string) =>
  createHash('sha256')
    .update(`${String(page.id)}\0${page.passwordHash ?? ''}\0${password}`)
    .digest('base64url')

function rememberVerified(key: string) {
  if (verified.size >= VERIFIED_MAX) {
    const oldest = verified.keys().next().value
    if (oldest !== undefined) verified.delete(oldest)
  }
  verified.set(key, Date.now() + VERIFIED_TTL_MS)
}

function recentlyVerified(key: string): boolean {
  const until = verified.get(key)
  if (until === undefined) return false
  if (until > Date.now()) return true
  verified.delete(key)
  return false
}

/** Test hook: forget cached verifications. */
export function clearVerifiedPasswords(): void {
  verified.clear()
}

export type PasswordAttempt =
  | { ok: true }
  | { ok: false; reason: 'invalid-password' | 'rate-limited'; retryAfterSeconds?: number }

/**
 * Checks `password` against a password-protected page, spending a rate-limit point first so a
 * blocked client learns nothing. Used by the login route and by `?pw=`.
 */
export async function attemptStatusPagePassword(
  payload: Payload,
  page: AccessPage,
  password: string,
  request: { headers: Headers },
): Promise<PasswordAttempt> {
  if (page.access !== 'password' || !page.passwordHash)
    return { ok: false, reason: 'invalid-password' }

  const cacheKey = verifiedKey(page, password)
  if (recentlyVerified(cacheKey)) return { ok: true }

  const { ip } = await requestMeta(payload, request)
  const pageId = String(page.id)
  const decision = ip
    ? await statusPagePasswordLimiter.consume(`${pageId}:ip:${ip}`)
    : await statusPagePasswordPageLimiter.consume(pageId)
  if (!decision.allowed) {
    return { ok: false, reason: 'rate-limited', retryAfterSeconds: decision.retryAfterSeconds }
  }

  if (!(await verifyPassword(password, page.passwordHash))) {
    return { ok: false, reason: 'invalid-password' }
  }
  rememberVerified(cacheKey)
  return { ok: true }
}

// ---------------------------------------------------------------------------------------------
// Access cookie

const SESSION_PURPOSE = 'marmot:status-page-access'
export const ACCESS_COOKIE_PREFIX = 'marmot_sp_'

const sessionKey = () =>
  new Uint8Array(createHash('sha256').update(`${SESSION_PURPOSE}:${env.PAYLOAD_SECRET}`).digest())

/**
 * Keyed digest of the page's access mode and stored password hash: changes with every new password
 * and every mode switch, reveals nothing about either.
 */
const credentialFingerprint = (page: AccessPage): string =>
  createHmac('sha256', sessionKey())
    .update(`${String(page.id)}\0${page.access ?? 'public'}\0${page.passwordHash ?? ''}`)
    .digest('base64url')
    .slice(0, 22)

/** Cookie name of a page; one cookie per page, so access to one page never opens another. */
export const accessCookieName = (pageId: string | number): string =>
  `${ACCESS_COOKIE_PREFIX}${String(pageId).replace(/[^A-Za-z0-9_-]/g, '')}`

export const accessSessionSeconds = (): number => env.STATUS_PAGE_SESSION_DAYS * 24 * 60 * 60

export async function signAccessToken(
  page: AccessPage,
  {
    now = Date.now(),
    ttlSeconds = accessSessionSeconds(),
    viewer,
  }: { now?: number; ttlSeconds?: number; viewer?: string | number } = {},
): Promise<string> {
  const issuedAt = Math.floor(now / 1000)
  const claims: Record<string, string> = { cf: credentialFingerprint(page) }
  if (viewer !== undefined) claims.vid = String(viewer)
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'HS256' })
    .setAudience(SESSION_PURPOSE)
    .setSubject(String(page.id))
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + ttlSeconds)
    .sign(sessionKey())
}

export interface AccessTokenClaims {
  /** `status-page-viewers` id (email-domain sessions). */
  viewer: string | null
}

/**
 * The claims of `token` when it was issued for this page in its current mode (and with its current
 * password) and has not expired; `null` otherwise.
 */
export async function readAccessToken(
  page: AccessPage,
  token: string | null | undefined,
  { now = Date.now() } = {},
): Promise<AccessTokenClaims | null> {
  if (!token) return null
  try {
    const { payload } = await jwtVerify(token, sessionKey(), {
      algorithms: ['HS256'],
      audience: SESSION_PURPOSE,
      subject: String(page.id),
      currentDate: new Date(now),
    })
    if (payload.cf !== credentialFingerprint(page)) return null
    return { viewer: typeof payload.vid === 'string' ? payload.vid : null }
  } catch {
    return null
  }
}

/** True when `token` was issued for this page in its current mode and has not expired. */
export async function verifyAccessToken(
  page: AccessPage,
  token: string | null | undefined,
  options: { now?: number } = {},
): Promise<boolean> {
  return (await readAccessToken(page, token, options)) !== null
}

/** `https` request (directly or behind a proxy), or an https server URL. */
export function isSecureRequest(request: { headers: Headers; url?: string }): boolean {
  const forwarded = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim()
  if (forwarded) return forwarded === 'https'
  if (request.url && request.url.startsWith('https://')) return true
  return cookiesAreSecure()
}

/**
 * `Set-Cookie` for a page session. `Path=/` because the page, its API, feed and badges live under
 * different paths (and at `/` on custom domains); the cookie name and the signed page id scope it
 * to one page.
 */
export function accessCookie(
  pageId: string | number,
  token: string,
  { secure, maxAge = accessSessionSeconds() }: { secure: boolean; maxAge?: number },
): string {
  return `${accessCookieName(pageId)}=${token}; Max-Age=${maxAge}; Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`
}

// ---------------------------------------------------------------------------------------------
// Strategies

const publicStrategy: AccessStrategy = async () => ({
  allowed: true,
  via: 'public',
  restricted: false,
})

const passwordStrategy: AccessStrategy = async ({ payload, page, request, options }) => {
  if (!page.passwordHash) return { allowed: false, reason: 'login-required' }

  const token = readCookie(request.headers.get('cookie'), accessCookieName(page.id))
  if (await verifyAccessToken(page, token))
    return { allowed: true, via: 'session', restricted: true }

  const password = options.acceptPasswordParam ? request.searchParams?.get(PASSWORD_PARAM) : null
  if (password) {
    const attempt = await attemptStatusPagePassword(payload, page, password, request)
    if (attempt.ok) return { allowed: true, via: 'password', restricted: true }
    return { allowed: false, reason: attempt.reason, retryAfterSeconds: attempt.retryAfterSeconds }
  }
  return { allowed: false, reason: 'login-required' }
}

const emailDomainStrategy: AccessStrategy = async ({ payload, page, request }) => {
  const denied: StatusPageAccessDecision = { allowed: false, reason: 'login-required' }
  const token = readCookie(request.headers.get('cookie'), accessCookieName(page.id))
  const claims = await readAccessToken(page, token)
  if (!claims?.viewer) return denied

  const viewer = await payload
    .findByID({
      collection: 'status-page-viewers',
      id: claims.viewer,
      depth: 0,
      overrideAccess: true,
      disableErrors: true,
    })
    .catch(() => null)
  if (!viewer || viewer.status !== 'active') return denied
  const viewerPage = typeof viewer.page === 'object' ? viewer.page.id : viewer.page
  if (String(viewerPage) !== String(page.id)) return denied
  if (!isEmailAllowed(page, viewer.email)) return denied

  await touchViewer(payload, viewer)
  return { allowed: true, via: 'session', restricted: true }
}

const ipAllowlistStrategy: AccessStrategy = async ({ payload, page, request }) => {
  const { ip } = await requestMeta(payload, request)
  if (ip && ipAllowListFor(page.allowedIpRanges).allows(ip)) {
    // The answer depends on the client address: never let a shared cache replay it.
    return { allowed: true, via: 'ip', restricted: true }
  }
  return { allowed: false, reason: 'ip-not-allowed' }
}

export const ACCESS_STRATEGIES: Record<StatusPageAccessMode, AccessStrategy> = {
  public: publicStrategy,
  password: passwordStrategy,
  'email-domain': emailDomainStrategy,
  'ip-allowlist': ipAllowlistStrategy,
}

/** True when the page needs more than a URL to view (any mode but `public`). */
export const isProtectedPage = (page: Pick<StatusPage, 'access'>): boolean =>
  (page.access ?? 'public') !== 'public'

/**
 * May the visitor behind `request` view `page`? `page` must be a published page loaded with
 * `overrideAccess: true` (the password hash is not readable otherwise) and must carry the access
 * fields of `AccessPage`.
 */
export async function checkStatusPageAccess(
  payload: Payload,
  page: AccessPage,
  request: AccessRequest,
  options: AccessOptions = {},
): Promise<StatusPageAccessDecision> {
  const mode = (page.access ?? 'public') as StatusPageAccessMode
  const strategy = Object.prototype.hasOwnProperty.call(ACCESS_STRATEGIES, mode)
    ? ACCESS_STRATEGIES[mode]
    : null
  if (!strategy) return { allowed: false, reason: 'login-required' }
  return strategy({ payload, page, request, options: { acceptPasswordParam: true, ...options } })
}

// ---------------------------------------------------------------------------------------------
// Responses

export const PROTECTED_CACHE_CONTROL = 'private, no-store'

/** `Cache-Control` for a granted response: `publicValue` for public pages, private otherwise. */
export const accessCacheControl = (
  decision: Extract<StatusPageAccessDecision, { allowed: true }>,
  publicValue: string,
): string => (decision.restricted ? PROTECTED_CACHE_CONTROL : publicValue)

/** Extra headers for every response of a protected page: never cached publicly, never indexed. */
export const protectedHeaders = (): Record<string, string> => ({
  'Cache-Control': PROTECTED_CACHE_CONTROL,
  'X-Robots-Tag': 'noindex, nofollow',
})

const DENIAL_MESSAGES: Record<AccessDenial, ErrorKey> = {
  'login-required': 'statusPageProtected',
  'invalid-password': 'statusPagePasswordIncorrect',
  'rate-limited': 'tooManyAttempts',
  'ip-not-allowed': 'statusPageIpNotAllowed',
}

const DENIAL_STATUS: Record<AccessDenial, number> = {
  'login-required': 401,
  'invalid-password': 401,
  'rate-limited': 429,
  'ip-not-allowed': 403,
}

/**
 * 401 (sign-in required), 403 (IP not allowed) or 429 (rate limited) for machine endpoints, JSON or
 * plain text.
 */
export function accessDeniedResponse(
  decision: Extract<StatusPageAccessDecision, { allowed: false }>,
  format: 'json' | 'text' = 'json',
  locale: Locale = defaultLocale,
): Response {
  const status = DENIAL_STATUS[decision.reason]
  const headers: Record<string, string> = { ...protectedHeaders() }
  if (decision.retryAfterSeconds) headers['Retry-After'] = String(decision.retryAfterSeconds)
  const message = translateError(locale, DENIAL_MESSAGES[decision.reason])
  if (format === 'text') {
    return new Response(message, {
      status,
      headers: { ...headers, 'Content-Type': 'text/plain; charset=utf-8' },
    })
  }
  return Response.json({ error: message, code: decision.reason }, { status, headers })
}
