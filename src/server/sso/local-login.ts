import type {
  CollectionBeforeLoginHook,
  CollectionBeforeOperationHook,
  Payload,
  PayloadRequest,
  RequestContext,
} from 'payload'

import { env } from '@/env'
import { childLogger } from '@/lib/logger'
import type { User } from '@/payload-types'
import { apiError } from '@/server/errors'
import { recordRequestAuditEvent } from '@/server/security/audit'
import { SETUP_SESSION_CONTEXT } from '@/server/setup'

import { passwordAllowedUnderEnforcement } from './enforcement'

const log = childLogger('sso')

/**
 * SSO-only mode (`OIDC_DISABLE_LOCAL_LOGIN`): no password logins, sign-ups or password resets on
 * the whole instance. With `OIDC_BREAK_GLASS` a superadmin can still sign in with a password from
 * `/login?local=1` (which posts to `/api/auth/login?local=1`); every such login is audited as
 * `auth.break_glass`. Organizations' own enforcement (`organizations.enforceSso`) applies on top.
 */

/** `req.context` flag: the caller asked for the local (break-glass) login, `?local=1`. */
export const LOCAL_LOGIN_CONTEXT = 'marmotLocalLogin'

export const isLocalLoginDisabled = (): boolean => env.OIDC_DISABLE_LOCAL_LOGIN
export const isBreakGlassEnabled = (): boolean =>
  env.OIDC_DISABLE_LOCAL_LOGIN && env.OIDC_BREAK_GLASS

/** `?local=1` on a URL. */
export const wantsLocalLogin = (url: string | URL | null | undefined): boolean => {
  if (!url) return false
  try {
    return new URL(url, 'http://marmot.local').searchParams.get('local') === '1'
  } catch {
    return false
  }
}

const localRequested = (req: PayloadRequest, context: RequestContext | undefined): boolean =>
  context?.[LOCAL_LOGIN_CONTEXT] === true || req.searchParams?.get('local') === '1'

export type PasswordDecision =
  | {
      allowed: true
      breakGlass:
        null | { scope: 'instance' } | { scope: 'organization'; organization: string | number }
    }
  | { allowed: false; error: 'localLoginDisabled' | 'ssoEnforced' }

/**
 * May `user` use their password right now? The instance-wide SSO-only mode first (break-glass:
 * superadmins, only when asked for with `local`), then the organization's enforcement (owners and
 * superadmins keep a break-glass path there).
 */
export async function passwordDecision(
  payload: Payload,
  user: Pick<User, 'id' | 'email' | 'superadmin' | 'organizations'>,
  options: { local: boolean },
): Promise<PasswordDecision> {
  let breakGlass: Extract<PasswordDecision, { allowed: true }>['breakGlass'] = null
  if (isLocalLoginDisabled()) {
    if (!(isBreakGlassEnabled() && user.superadmin === true && options.local)) {
      return { allowed: false, error: 'localLoginDisabled' }
    }
    breakGlass = { scope: 'instance' }
  }
  const org = await passwordAllowedUnderEnforcement(payload, user)
  if (org === false) return { allowed: false, error: 'ssoEnforced' }
  if (org !== null && breakGlass === null) breakGlass = { scope: 'organization', organization: org }
  return { allowed: true, breakGlass }
}

/**
 * `users.beforeLogin`: refuses password logins the SSO-only mode or an organization's enforcement
 * forbids (`POST /api/users/login`, Marmot's `POST /api/auth/login`, `payload.login`, and the login
 * that follows a password reset), and audits break-glass logins. Single sign-on never calls
 * `login`, so it is unaffected.
 */
export const refusePasswordLogin: CollectionBeforeLoginHook = async ({ user, req, context }) => {
  const account = user as User | null | undefined
  if (!account?.email) return user
  // The setup wizard signs in the administrator it just created (once, on a fresh install).
  if (context?.[SETUP_SESSION_CONTEXT] === true) return user
  const decision = await passwordDecision(req.payload, account, {
    local: localRequested(req, context),
  })
  if (!decision.allowed) {
    log.info({ user: account.id, reason: decision.error }, 'password login refused')
    throw apiError(decision.error, 403)
  }
  if (decision.breakGlass) {
    const organization =
      decision.breakGlass.scope === 'organization' ? decision.breakGlass.organization : null
    log.warn({ user: account.id, scope: decision.breakGlass.scope }, 'break-glass password login')
    await recordRequestAuditEvent(req.payload, req, {
      action: 'auth.break_glass',
      actor: account.id,
      actorLabel: account.email,
      organization,
      target: `users:${String(account.id)}`,
      entityType: 'user',
      entityId: account.id,
      entityLabel: account.email,
      metadata: {
        scope: decision.breakGlass.scope,
        reason:
          decision.breakGlass.scope === 'instance'
            ? 'password login while local login is disabled'
            : 'password login while single sign-on is enforced',
      },
      req,
    })
  }
  return user
}

async function userByEmail(payload: Payload, email: string | null) {
  if (!email) return null
  const { docs } = await payload.find({
    collection: 'users',
    where: { email: { equals: email } },
    limit: 1,
    depth: 0,
    overrideAccess: true,
  })
  return docs[0] ?? null
}

async function userByResetToken(payload: Payload, token: unknown) {
  if (typeof token !== 'string' || !token) return null
  const { docs } = await payload.find({
    collection: 'users',
    where: { resetPasswordToken: { equals: token } },
    limit: 1,
    depth: 0,
    overrideAccess: true,
    showHiddenFields: true,
  })
  return docs[0] ?? null
}

/**
 * `users.beforeOperation` for password resets through the API (`/api/users/forgot-password`,
 * `/api/users/reset-password`):
 *
 * - SSO-only mode: refused with 403, unless break-glass is on. Then `forgot-password?local=1` is
 *   accepted but only mails superadmins (everyone else gets the same answer and no mail, so the
 *   response does not reveal who is a superadmin), and `reset-password` only works for them.
 * - Organization enforcement: reset mails go only to users who could log in with the password
 *   afterwards (owners, superadmins), and resetting anyone else's password is refused.
 */
export const refusePasswordReset: CollectionBeforeOperationHook = async ({
  args,
  operation,
  req,
  context,
}) => {
  const op = operation as string
  if ((op !== 'forgotPassword' && op !== 'resetPassword') || req.payloadAPI === 'local') {
    return args
  }
  const payload = req.payload

  if (op === 'forgotPassword') {
    const local = localRequested(req, context)
    if (isLocalLoginDisabled() && !(isBreakGlassEnabled() && local)) {
      throw apiError('localLoginDisabled', 403)
    }
    const data = (args as { data?: { email?: unknown } }).data
    const email = typeof data?.email === 'string' ? data.email.trim().toLowerCase() : null
    const user = await userByEmail(payload, email)
    if (user && !(await passwordDecision(payload, user, { local })).allowed) {
      log.info({ user: user.id }, 'password reset mail suppressed: password login not allowed')
      return { ...args, disableEmail: true }
    }
    return args
  }

  if (isLocalLoginDisabled() && !isBreakGlassEnabled()) throw apiError('localLoginDisabled', 403)
  const token = (args as { data?: { token?: unknown } }).data?.token
  const user = await userByResetToken(payload, token)
  if (!user) return args // Payload answers an unknown token itself.
  // The reset link proves access to the mailbox; it stands in for `?local=1` for the login that
  // follows the reset.
  const decision = await passwordDecision(payload, user, { local: true })
  if (!decision.allowed) throw apiError(decision.error, 403)
  if (isLocalLoginDisabled()) context[LOCAL_LOGIN_CONTEXT] = true
  return args
}
