/**
 * Passwordless sign-in with a link sent by email (#164).
 *
 * 1. `POST /api/auth/magic-link { email, next? }` (the "Email me a sign-in link" form on `/login`) is
 *    rate limited per client IP (or, without a trusted address, per instance) and per address, then
 *    answered at once with the same `202 { sent: true }` whatever the address: whether an account
 *    exists is never revealed, not even through timing, because the lookup and the email happen in
 *    the background (`deliver`).
 * 2. An existing account gets a `magic-link` token, an unknown address a `magic-link-signup` token
 *    when it may create an account (sign-up allowed, or a pending invitation for the address, the
 *    rules single sign-on provisioning follows). Tokens come from `email-tokens.ts`: 256 random
 *    bits, SHA-256 digest in Redis, 15 minutes, single use, the newest link per address revokes
 *    the previous one. The link opens `/login/magic-link?token=…`, a page with a button that posts
 *    the token back, so mail scanners that prefetch links cannot use it up.
 * 3. `POST /api/auth/magic-link/verify { token }` redeems it. The account must still have the
 *    address, the method must still be on, and the password policy must allow a local login (see
 *    below). A new account is created for a signup link. Redeeming confirms the address (#177).
 *    Accounts with two-factor authentication continue to the code step (`requiresTwoFactor` and
 *    the `marmot-2fa` challenge cookie, as after a password); others get the session cookie.
 *
 * Policy: a sign-in link counts as a **local login**, like a password. The SSO-only mode
 * (`OIDC_DISABLE_LOCAL_LOGIN`) turns the method off entirely, break-glass included (break-glass is
 * the password at `/login?local=1`), and an organization's `enforceSso` refuses links for users on
 * its verified domains exactly as it refuses their passwords: owners and superadmins keep their
 * break-glass path, audited as `auth.break_glass`. Unknown addresses on an enforced domain get no
 * account (they sign in through the organization's identity provider).
 */
import { createHash, randomBytes } from 'node:crypto'

import { getPayload, type Payload } from 'payload'

import config from '@payload-config'
import { createPayloadSessionCookie } from '@/auth/session'
import { findPendingInvitation } from '@/auth/sso/hooks'
import { issueTwoFactorChallenge, publicUser } from '@/auth/two-factor/handlers'
import { acceptInvitation } from '@/collections/Invitations'
import { env } from '@/env'
import { isLocale, type Locale } from '@/i18n/locales'
import { childLogger } from '@/lib/logger'
import { MAGIC_LINK_TTL_MINUTES } from '@/lib/magic-link'
import { escapeHtml } from '@/lib/markdown'
import { normalizeEmail } from '@/lib/status-page-access'
import { safeNextPath } from '@/lib/utils'
import type { User } from '@/payload-types'
import { emailButton, emailLayout } from '@/server/email/layout'
import type { ErrorKey } from '@/server/errors'
import { serverTranslator } from '@/server/i18n'
import { errorText, requestLocale } from '@/server/request-locale'
import { auditTarget, recordRequestAuditEvent, recordUserAuditEvent } from '@/server/security/audit'
import {
  createRateLimiter,
  tooManyRequests,
  type RateLimitDecision,
  type RateLimiter,
} from '@/server/security/rate-limit'
import { requestMeta } from '@/server/security/request'
import { isMagicLinkEnabled, isSignupAllowed } from '@/server/settings'
import { enforcingOrganizationFor } from '@/server/sso/enforcement'
import { isLocalLoginDisabled, passwordDecision } from '@/server/sso/local-login'

import {
  addressTokenSubject,
  consumeEmailToken,
  issueEmailToken,
  normalizeTokenEmail,
  type RedeemedEmailToken,
} from './email-tokens'
import { EMAIL_VERIFICATION_RATE_LIMIT, markEmailVerified } from './email-verification'

const log = childLogger('magic-link')

export { MAGIC_LINK_TTL_MINUTES }
export const MAGIC_LINK_TTL_SECONDS = MAGIC_LINK_TTL_MINUTES * 60

// ---------------------------------------------------------------------------------------------
// Rate limits

/** Links per address: like verification and password reset mails, five per quarter hour. */
export const MAGIC_LINK_EMAIL_RATE_LIMIT = EMAIL_VERIFICATION_RATE_LIMIT
/** Link requests per client IP (behind a trusted proxy), across addresses. */
export const MAGIC_LINK_IP_RATE_LIMIT = { points: 20, duration: 15 * 60 }
/**
 * Without a trusted client address (`trustProxy` off) every visitor shares this bucket. It also
 * bounds how much mail strangers can make the instance send while sign-up is open.
 */
export const MAGIC_LINK_INSTANCE_RATE_LIMIT = { points: 100, duration: 15 * 60 }

export const magicLinkEmailLimiter: RateLimiter = createRateLimiter(
  'magic-link-email',
  MAGIC_LINK_EMAIL_RATE_LIMIT,
)
export const magicLinkIpLimiter: RateLimiter = createRateLimiter(
  'magic-link-ip',
  MAGIC_LINK_IP_RATE_LIMIT,
)
export const magicLinkInstanceLimiter: RateLimiter = createRateLimiter(
  'magic-link-instance',
  MAGIC_LINK_INSTANCE_RATE_LIMIT,
)

const digest = (value: string) => createHash('sha256').update(value).digest('base64url')

// ---------------------------------------------------------------------------------------------
// Background deliveries

const pending = new Set<Promise<void>>()

/** Test hook: waits for every link delivery started so far. */
export async function settleMagicLinkDeliveries(): Promise<void> {
  while (pending.size > 0) await Promise.allSettled([...pending])
}

const track = (work: Promise<void>) => {
  const promise = work.finally(() => pending.delete(promise))
  pending.add(promise)
}

// ---------------------------------------------------------------------------------------------
// Email

type RequestLike = { headers: Headers }

/** Link to the confirm page; `next` (a same-origin path) survives the round trip. */
export function magicLinkUrl(token: string, next?: string | null): string {
  const base = env.NEXT_PUBLIC_SERVER_URL.replace(/\/$/, '')
  const params = new URLSearchParams({ token })
  const path = safeNextPath(next)
  if (path !== '/') params.set('next', path)
  return `${base}/login/magic-link?${params.toString()}`
}

/** Subject and bodies of the sign-in mail (`signup`: the address has no account yet). */
export function renderMagicLinkEmail({
  email,
  url,
  locale,
  signup,
}: {
  email: string
  url: string
  locale: Locale
  signup: boolean
}): { to: string; subject: string; text: string; html: string } {
  const t = serverTranslator(locale)
  const kind = signup ? 'signup' : 'signIn'
  const intro = (strong: (chunks: string) => string, address: string) =>
    t.markup(`email.magicLink.${kind}.intro`, { email: address, strong })
  const expires = t('email.magicLink.expires', { minutes: MAGIC_LINK_TTL_MINUTES })
  const ignore = t('email.magicLink.ignore')
  return {
    to: email,
    subject: t(`email.magicLink.${kind}.subject`),
    text: [
      intro((chunks) => chunks, email),
      t('email.magicLink.link', { url }),
      expires,
      ignore,
    ].join('\n\n'),
    html: emailLayout(
      `<p>${intro((chunks) => `<strong>${chunks}</strong>`, escapeHtml(email))}</p>${emailButton(url, t(`email.magicLink.${kind}.button`))}<p style="color:#6b6760;font-size:13px">${escapeHtml(expires)}</p><p style="color:#6b6760;font-size:13px">${escapeHtml(ignore)}</p>`,
      '',
    ),
  }
}

// ---------------------------------------------------------------------------------------------
// Request

async function userByEmail(payload: Payload, email: string): Promise<User | null> {
  const { docs } = await payload.find({
    collection: 'users',
    where: { email: { equals: normalizeTokenEmail(email) } },
    limit: 1,
    depth: 0,
    overrideAccess: true,
  })
  return docs[0] ?? null
}

/**
 * May a sign-in link create an account for `email`? Sign-up allowed (`allowSignup`, never in the
 * SSO-only mode), or a pending invitation for the address; and no organization enforces single
 * sign-on for its domain.
 */
async function mayCreateAccount(payload: Payload, email: string): Promise<boolean> {
  if (!(await isSignupAllowed(payload)) && !(await findPendingInvitation(payload, email))) {
    return false
  }
  return !(await enforcingOrganizationFor(payload, email))
}

const localeOf = (user: Pick<User, 'language'> | null, fallback: Locale): Locale =>
  isLocale(user?.language) ? user.language : fallback

async function deliver(
  payload: Payload,
  email: string,
  request: RequestLike,
  locale: Locale,
  next: string | null,
): Promise<void> {
  const user = await userByEmail(payload, email)
  if (user) {
    const decision = await passwordDecision(payload, user, { local: false })
    if (!decision.allowed) {
      log.info({ user: user.id, reason: decision.error }, 'sign-in link suppressed')
      return
    }
  } else if (!(await mayCreateAccount(payload, email))) {
    return
  }

  const { token } = await issueEmailToken({
    purpose: user ? 'magic-link' : 'magic-link-signup',
    userId: user ? user.id : addressTokenSubject(email),
    email,
    ttlSeconds: MAGIC_LINK_TTL_SECONDS,
  })
  await payload.sendEmail(
    renderMagicLinkEmail({
      email,
      url: magicLinkUrl(token, next),
      locale: localeOf(user, locale),
      signup: !user,
    }),
  )
  await recordRequestAuditEvent(payload, request, {
    action: 'auth.magic_link_sent',
    actor: user?.id ?? null,
    actorLabel: email,
    target: user ? auditTarget('users', user.id) : null,
    entityType: 'user',
    entityId: user?.id ?? null,
    entityLabel: email,
    metadata: { signup: !user },
  })
}

export type MagicLinkRequestResult =
  | { ok: true }
  | { ok: false; reason: 'disabled' | 'local-login-disabled' | 'invalid-email' }
  | { ok: false; reason: 'rate-limited'; decision: RateLimitDecision }

/**
 * "Email me a sign-in link". Resolves before anything depends on the address, so the caller
 * answers identically for existing, unknown and refused addresses.
 */
export async function requestMagicLink(
  payload: Payload,
  rawEmail: unknown,
  request: Request,
  { next = null }: { next?: string | null } = {},
): Promise<MagicLinkRequestResult> {
  if (isLocalLoginDisabled()) return { ok: false, reason: 'local-login-disabled' }
  if (!(await isMagicLinkEnabled(payload))) return { ok: false, reason: 'disabled' }
  const email = normalizeEmail(rawEmail)
  if (!email) return { ok: false, reason: 'invalid-email' }

  const { ip } = await requestMeta(payload, request)
  const byClient = ip
    ? await magicLinkIpLimiter.consume(`ip:${ip}`)
    : await magicLinkInstanceLimiter.consume('instance')
  const byEmail = byClient.allowed ? await magicLinkEmailLimiter.consume(digest(email)) : byClient
  if (!byEmail.allowed) {
    await recordRequestAuditEvent(payload, request, {
      action: 'auth.rate_limited',
      metadata: { email, operation: 'magic-link' },
    })
    return { ok: false, reason: 'rate-limited', decision: byEmail }
  }

  // Headers copied: the delivery outlives the request.
  const headers = new Headers(request.headers)
  const locale = requestLocale(request)
  track(
    deliver(payload, email, { headers }, locale, next).catch((err: unknown) =>
      log.error({ err }, 'cannot send sign-in link'),
    ),
  )
  return { ok: true }
}

// ---------------------------------------------------------------------------------------------
// Redeem

export type MagicLinkRedeemResult =
  | {
      ok: true
      user: User
      /** The link created the account. */
      created: boolean
    }
  | { ok: false; reason: 'invalid' | 'disabled' }
  | {
      ok: false
      reason: 'forbidden'
      error: Extract<ErrorKey, 'localLoginDisabled' | 'ssoEnforced'>
    }

const toId = (payload: Payload, raw: string): User['id'] =>
  (payload.db.defaultIDType === 'number' && /^\d+$/.test(raw) ? Number(raw) : raw) as User['id']

async function consumeAny(token: unknown): Promise<{
  purpose: 'magic-link' | 'magic-link-signup'
  redeemed: RedeemedEmailToken
} | null> {
  const signIn = await consumeEmailToken({ purpose: 'magic-link', token })
  if (signIn) return { purpose: 'magic-link', redeemed: signIn }
  const signup = await consumeEmailToken({ purpose: 'magic-link-signup', token })
  return signup ? { purpose: 'magic-link-signup', redeemed: signup } : null
}

/** Creates the account a signup link was sent for, accepting a pending invitation like SSO does. */
async function createAccount(payload: Payload, email: string, request: Request): Promise<User> {
  const signupAllowed = await isSignupAllowed(payload)
  const user = await payload.create({
    collection: 'users',
    data: {
      email,
      // Nobody knows it: the account signs in with links (or SSO) until a password is set
      // through the reset flow.
      password: randomBytes(32).toString('base64url'),
      authProvider: 'magic-link',
      // The link proved the address.
      emailVerified: true,
      emailVerifiedAt: new Date().toISOString(),
      language: requestLocale(request),
    },
    depth: 0,
    overrideAccess: true,
  })
  log.info({ user: user.id }, 'account created from a sign-in link')
  if (!signupAllowed) {
    const invitation = await findPendingInvitation(payload, email)
    if (invitation?.token) {
      try {
        await acceptInvitation({ payload, token: invitation.token, user })
      } catch (error) {
        // The account exists either way; the invitation link can still be used afterwards.
        log.warn({ err: error, user: user.id }, 'could not accept invitation for a new account')
      }
    }
  }
  return user
}

/**
 * Redeems a sign-in link: the account it signs in (created for a signup link), or why not. Does
 * not create the session; `handleMagicLinkVerify` does, after the second factor when enabled.
 */
export async function redeemMagicLink(
  payload: Payload,
  token: unknown,
  request: Request,
): Promise<MagicLinkRedeemResult> {
  if (!(await isMagicLinkEnabled(payload))) return { ok: false, reason: 'disabled' }
  const consumed = await consumeAny(token)
  if (!consumed) return { ok: false, reason: 'invalid' }
  const { purpose, redeemed } = consumed
  const email = redeemed.email

  let user: User | null
  if (purpose === 'magic-link') {
    user = await payload
      .findByID({
        collection: 'users',
        id: toId(payload, redeemed.userId),
        depth: 0,
        overrideAccess: true,
      })
      .catch(() => null)
    // The account changed its address since the link was sent.
    if (!user || normalizeTokenEmail(user.email) !== email) return { ok: false, reason: 'invalid' }
  } else {
    // Someone may have signed up with the address since; the link proves the mailbox either way.
    user = await userByEmail(payload, email)
  }

  let created = false
  if (!user) {
    if (!(await mayCreateAccount(payload, email))) {
      await recordRequestAuditEvent(payload, request, {
        action: 'auth.login_failed',
        metadata: { email, operation: 'magic-link', reason: 'signup_disabled' },
      })
      return { ok: false, reason: 'invalid' }
    }
    user = await createAccount(payload, email, request)
    created = true
  }

  const decision = await passwordDecision(payload, user, { local: false })
  if (!decision.allowed) {
    await recordRequestAuditEvent(payload, request, {
      action: 'auth.login_failed',
      metadata: { email, operation: 'magic-link', status: 403, reason: decision.error },
    })
    return { ok: false, reason: 'forbidden', error: decision.error }
  }
  if (decision.breakGlass) {
    const organization =
      decision.breakGlass.scope === 'organization' ? decision.breakGlass.organization : null
    log.warn({ user: user.id, scope: decision.breakGlass.scope }, 'break-glass sign-in link')
    await recordUserAuditEvent(payload, request, user, 'auth.break_glass', {
      organization,
      metadata: {
        scope: decision.breakGlass.scope,
        method: 'magic-link',
        reason: 'sign-in link while single sign-on is enforced',
      },
    })
  }

  await markEmailVerified(payload, { userId: user.id, email, method: 'magic-link', request })
  return { ok: true, user, created }
}

// ---------------------------------------------------------------------------------------------
// Route handlers (Fetch `Request` → `Response`, so integration tests drive them without Next)

const noStore = (cookies: string[] = []) => {
  const headers = new Headers({ 'Cache-Control': 'no-store' })
  for (const cookie of cookies) headers.append('Set-Cookie', cookie)
  return headers
}

const errorResponse = (request: Request, key: ErrorKey, status: number) =>
  Response.json({ errors: [{ message: errorText(request, key) }] }, { status, headers: noStore() })

async function readBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = (await request.json()) as unknown
    return body && typeof body === 'object' ? (body as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** `POST /api/auth/magic-link` */
export async function handleMagicLinkRequest(request: Request): Promise<Response> {
  const body = await readBody(request)
  const payload = await getPayload({ config })
  const result = await requestMagicLink(payload, body.email, request, {
    next: typeof body.next === 'string' ? body.next : null,
  })
  if (result.ok) return Response.json({ sent: true }, { status: 202, headers: noStore() })
  switch (result.reason) {
    case 'local-login-disabled':
      return errorResponse(request, 'localLoginDisabled', 403)
    case 'disabled':
      return errorResponse(request, 'magicLinkDisabled', 403)
    case 'invalid-email':
      return errorResponse(request, 'invalidEmailAddress', 400)
    case 'rate-limited':
      return tooManyRequests(result.decision, request)
  }
}

/** `POST /api/auth/magic-link/verify` */
export async function handleMagicLinkVerify(request: Request): Promise<Response> {
  const { token } = await readBody(request)
  const payload = await getPayload({ config })
  const result = await redeemMagicLink(payload, token, request)
  if (!result.ok) {
    if (result.reason === 'disabled') return errorResponse(request, 'magicLinkDisabled', 403)
    if (result.reason === 'forbidden') return errorResponse(request, result.error, 403)
    return errorResponse(request, 'magicLinkInvalid', 400)
  }

  const { user, created } = result
  if (user.twoFactorEnabled === true) {
    const { challenge, cookie } = await issueTwoFactorChallenge(user.id, 'magic-link')
    return Response.json({ requiresTwoFactor: true, challenge }, { headers: noStore([cookie]) })
  }

  const session = await createPayloadSessionCookie({ payload, userId: user.id })
  await recordUserAuditEvent(payload, request, user, 'auth.login', {
    metadata: { method: 'magic-link', ...(created ? { created: true } : {}) },
  })
  return Response.json(
    { user: publicUser(user), exp: session.exp, created },
    { headers: noStore([session.cookie]) },
  )
}
