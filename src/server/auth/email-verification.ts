/**
 * Optional email verification for self-service sign-up (#177).
 *
 * While the instance setting `requireEmailVerification` (default `REQUIRE_EMAIL_VERIFICATION`) is
 * on, an account created by a client (`POST /api/users`: the `/signup` page) starts with
 * `emailVerified: false` and gets a link (`/verify-email?token=…`, valid 24 hours, single use,
 * `src/server/auth/email-tokens.ts`). Until the link is used the user can sign in but only sees
 * the "check your inbox" screen, and creating organizations, invitations and notification
 * channels answers 403 (`requireVerifiedEmail`).
 *
 * Everybody else counts as verified: `emailVerified` defaults to `true` (existing rows too), so
 * accounts created by the setup wizard, server code, superadmins, before the setting was turned on
 * or while it is off are never locked out. Accepting an invitation sent to the account's address
 * and signing in through single sign-on with a verified address confirm a pending account.
 */
import type {
  CollectionAfterChangeHook,
  CollectionBeforeChangeHook,
  CollectionBeforeOperationHook,
  Payload,
  PayloadRequest,
} from 'payload'

import { isSuperadmin } from '@/access/permissions'
import { env } from '@/env'
import { defaultLocale, isLocale, type Locale } from '@/i18n/locales'
import { childLogger } from '@/lib/logger'
import { escapeHtml } from '@/lib/markdown'
import type { User } from '@/payload-types'
import { emailButton, emailLayout } from '@/server/email/layout'
import { apiError } from '@/server/errors'
import { serverTranslator } from '@/server/i18n'
import { auditTarget, recordRequestAuditEvent } from '@/server/security/audit'
import { createRateLimiter, type RateLimiter } from '@/server/security/rate-limit'
import { isEmailVerificationRequired } from '@/server/settings'

import {
  consumeEmailToken,
  issueEmailToken,
  normalizeTokenEmail,
  revokeEmailTokens,
} from './email-tokens'

const log = childLogger('email-verification')

export const EMAIL_VERIFICATION_TTL_HOURS = 24
export const EMAIL_VERIFICATION_TTL_SECONDS = EMAIL_VERIFICATION_TTL_HOURS * 60 * 60

/** Verification mails per account, like password reset mails: five per quarter hour. */
export const EMAIL_VERIFICATION_RATE_LIMIT = { points: 5, duration: 15 * 60 }
export const emailVerificationLimiter: RateLimiter = createRateLimiter(
  'email-verification',
  EMAIL_VERIFICATION_RATE_LIMIT,
)

/** How a pending account was confirmed (`auth.email_verified` metadata). */
export type EmailVerificationMethod = 'link' | 'invitation' | 'sso' | 'magic-link'

/** `req.context` flag: the users operation was made by a client, not by server code. */
const CLIENT_WRITE_CONTEXT = 'marmotUserClientWrite'

type VerifiableUser = Pick<User, 'id' | 'email'> &
  Partial<Pick<User, 'emailVerified' | 'superadmin' | 'language'>>

type RequestLike = { headers: Headers }

export const verificationUrl = (token: string): string =>
  `${env.NEXT_PUBLIC_SERVER_URL.replace(/\/$/, '')}/verify-email?token=${encodeURIComponent(token)}`

const sameAddress = (a: unknown, b: unknown): boolean =>
  typeof a === 'string' &&
  typeof b === 'string' &&
  normalizeTokenEmail(a) === normalizeTokenEmail(b)

/** `false` stored on the account. A missing value (rows from before #177 on MongoDB) is verified. */
export const isUnverified = (
  user: { emailVerified?: boolean | null } | null | undefined,
): boolean => user?.emailVerified === false

/**
 * Does `user` still have to confirm their address? Only while the instance requires it, and never
 * for superadmins (the first admin must not be locked out of their own instance).
 */
export async function needsEmailVerification(
  payload: Payload,
  user: (Partial<VerifiableUser> & { collection?: string }) | null | undefined,
): Promise<boolean> {
  if (!user || (user.collection && user.collection !== 'users')) return false
  if (!isUnverified(user) || user.superadmin === true) return false
  return isEmailVerificationRequired(payload)
}

const localeOf = (user: Partial<VerifiableUser>): Locale =>
  isLocale(user.language) ? user.language : defaultLocale

/** Subject and bodies of the verification mail, in the user's language. */
export function renderEmailVerificationEmail({
  email,
  url,
  locale,
}: {
  email: string
  url: string
  locale: Locale
}): { to: string; subject: string; text: string; html: string } {
  const t = serverTranslator(locale)
  const intro = (strong: (chunks: string) => string, address: string) =>
    t.markup('email.verification.intro', { email: address, strong })
  const expires = t('email.verification.expires', { hours: EMAIL_VERIFICATION_TTL_HOURS })
  const ignore = t('email.verification.ignore')
  return {
    to: email,
    subject: t('email.verification.subject'),
    text: [
      intro((chunks) => chunks, email),
      t('email.verification.link', { url }),
      expires,
      ignore,
    ].join('\n\n'),
    html: emailLayout(
      `<p>${intro((chunks) => `<strong>${chunks}</strong>`, escapeHtml(email))}</p>${emailButton(url, t('email.verification.button'))}<p style="color:#6b6760;font-size:13px">${escapeHtml(expires)}</p><p style="color:#6b6760;font-size:13px">${escapeHtml(ignore)}</p>`,
      '',
    ),
  }
}

/**
 * Mints a fresh link for `user` (revoking the previous one), mails it and records
 * `auth.email_verification_sent`. Throws when the token cannot be stored or the mail not sent.
 * Pass `req` from inside a Payload operation so the audit row joins its transaction.
 */
export async function sendVerificationEmail(
  payload: Payload,
  user: VerifiableUser,
  options: { request?: RequestLike; req?: PayloadRequest; reason?: 'signup' | 'resend' } = {},
): Promise<{ expiresAt: Date }> {
  const { token, expiresAt } = await issueEmailToken({
    purpose: 'email-verification',
    userId: user.id,
    email: user.email,
    ttlSeconds: EMAIL_VERIFICATION_TTL_SECONDS,
  })
  await payload.sendEmail(
    renderEmailVerificationEmail({
      email: user.email,
      url: verificationUrl(token),
      locale: localeOf(user),
    }),
  )
  await recordRequestAuditEvent(
    payload,
    options.req ?? options.request ?? { headers: new Headers() },
    {
      action: 'auth.email_verification_sent',
      actor: user.id,
      actorLabel: user.email,
      target: auditTarget('users', user.id),
      entityType: 'user',
      entityId: user.id,
      entityLabel: user.email,
      metadata: { reason: options.reason ?? 'signup' },
      req: options.req,
    },
  )
  return { expiresAt }
}

/**
 * Confirms the pending account `userId` when its current address is `email`. No-op (returns
 * `false`) for accounts that are verified already or whose address changed since. Records
 * `auth.email_verified` with the method and revokes any outstanding link.
 */
export async function markEmailVerified(
  payload: Payload,
  {
    userId,
    email,
    method,
    request,
    req,
  }: {
    userId: string | number
    email: string
    method: EmailVerificationMethod
    request?: RequestLike
    req?: PayloadRequest
  },
): Promise<boolean> {
  const user = await payload
    .findByID({ collection: 'users', id: userId, depth: 0, overrideAccess: true, req })
    .catch(() => null)
  if (!user || !isUnverified(user) || !sameAddress(user.email, email)) return false

  await payload.update({
    collection: 'users',
    id: user.id,
    data: { emailVerified: true, emailVerifiedAt: new Date().toISOString() },
    depth: 0,
    overrideAccess: true,
    req,
  })
  await recordRequestAuditEvent(payload, req ?? request ?? { headers: new Headers() }, {
    action: 'auth.email_verified',
    actor: user.id,
    actorLabel: user.email,
    target: auditTarget('users', user.id),
    entityType: 'user',
    entityId: user.id,
    entityLabel: user.email,
    metadata: { method },
    req,
  })
  await revokeEmailTokens('email-verification', user.id)
  return true
}

export type VerifyTokenResult =
  { ok: true; userId: string; email: string; alreadyVerified: boolean } | { ok: false }

/**
 * Redeems a verification link (`POST /api/auth/verify-email`). Fails for unknown, expired or used
 * tokens and for links sent to an address the account no longer has.
 */
export async function verifyEmailToken(
  payload: Payload,
  token: unknown,
  request?: RequestLike,
): Promise<VerifyTokenResult> {
  const redeemed = await consumeEmailToken({ purpose: 'email-verification', token })
  if (!redeemed) return { ok: false }
  const user = await payload
    .findByID({ collection: 'users', id: redeemed.userId, depth: 0, overrideAccess: true })
    .catch(() => null)
  if (!user || !sameAddress(user.email, redeemed.email)) return { ok: false }
  const changed = await markEmailVerified(payload, {
    userId: user.id,
    email: redeemed.email,
    method: 'link',
    request,
  })
  return { ok: true, userId: String(user.id), email: user.email, alreadyVerified: !changed }
}

// ---------------------------------------------------------------------------------------------
// Hooks

/**
 * `beforeOperation` on organizations, invitations and notifications: creating them needs a
 * confirmed address while the instance requires one. API keys and server code (no user) pass.
 */
export const requireVerifiedEmail: CollectionBeforeOperationHook = async ({
  args,
  operation,
  req,
}) => {
  if (operation !== 'create') return args
  if (await needsEmailVerification(req.payload, req.user as VerifiableUser | null)) {
    throw apiError('emailNotVerified', 403)
  }
  return args
}

/**
 * `users.beforeOperation`: remembers whether a create or update comes from a client (REST,
 * GraphQL, Local API with `overrideAccess: false`) rather than from server code or a superadmin.
 * Field access drops a client's own `emailVerified`, so the decision is made here and applied in
 * `applyEmailVerificationState`.
 */
export const flagClientUserWrite: CollectionBeforeOperationHook = ({ args, operation, req }) => {
  if (operation !== 'create' && operation !== 'update' && operation !== 'updateByID') return args
  const overrideAccess = (args as { overrideAccess?: boolean }).overrideAccess === true
  req.context[CLIENT_WRITE_CONTEXT] = !overrideAccess && !isSuperadmin(req.user)
  return args
}

/**
 * `users.beforeChange`: a self-service sign-up, or a user changing their own address, starts (again)
 * unverified while the instance requires verification. Everything else keeps the stored value or
 * the default (`true`).
 */
export const applyEmailVerificationState: CollectionBeforeChangeHook<User> = async ({
  data,
  operation,
  originalDoc,
  req,
}) => {
  if (req.context[CLIENT_WRITE_CONTEXT] !== true) return data
  const signup = operation === 'create'
  const addressChanged =
    operation === 'update' &&
    typeof data.email === 'string' &&
    !sameAddress(data.email, originalDoc?.email)
  if ((signup || addressChanged) && (await isEmailVerificationRequired(req.payload))) {
    data.emailVerified = false
    data.emailVerifiedAt = null
  }
  return data
}

/**
 * `users.afterChange`: mails the link when an account becomes pending (sign-up, address change,
 * an SSO account without a verified address). A delivery failure never fails the write; the user
 * can ask for another link from the "check your inbox" screen.
 */
export const sendVerificationOnChange: CollectionAfterChangeHook<User> = async ({
  doc,
  previousDoc,
  operation,
  req,
}) => {
  if (!isUnverified(doc)) return doc
  const pendingNow =
    operation === 'create' ||
    !isUnverified(previousDoc) ||
    !sameAddress(previousDoc?.email, doc.email)
  if (!pendingNow || !(await isEmailVerificationRequired(req.payload))) return doc
  try {
    await sendVerificationEmail(req.payload, doc, { req, reason: 'signup' })
  } catch (error) {
    log.error({ err: error, user: doc.id }, 'failed to send the verification email')
  }
  return doc
}
