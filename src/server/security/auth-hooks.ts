import {
  APIError,
  type CollectionAfterErrorHook,
  type CollectionAfterLoginHook,
  type CollectionBeforeOperationHook,
} from 'payload'

import { recordAuditEvent, recordRequestAuditEvent } from './audit'
import { createRateLimiter, rateLimitHeaders, type RateLimiter } from './rate-limit'
import { requestMeta } from './request'

/**
 * Brute-force protection and audit trail for Payload's own auth operations on `users`
 * (`POST /api/users/login`, `POST /api/users/forgot-password`). Hooked as `beforeOperation`,
 * which runs before the password is checked, so failed attempts count too.
 *
 * Buckets: the client IP when a trusted proxy supplies one (instance setting `trustProxy`),
 * otherwise the account being targeted. Local API calls (`payload.login` from server code, tests,
 * the setup wizard) are never limited.
 */
export const LOGIN_RATE_LIMIT = { points: 10, duration: 60, blockDuration: 5 * 60 }
export const FORGOT_PASSWORD_RATE_LIMIT = { points: 5, duration: 15 * 60 }

export const loginLimiter: RateLimiter = createRateLimiter('login', LOGIN_RATE_LIMIT)
export const forgotPasswordLimiter: RateLimiter = createRateLimiter(
  'forgot-password',
  FORGOT_PASSWORD_RATE_LIMIT,
)

type AuthAttempt = { operation: 'login' | 'forgotPassword'; email: string | null }

const limiterFor: Record<AuthAttempt['operation'], RateLimiter> = {
  login: loginLimiter,
  forgotPassword: forgotPasswordLimiter,
}

const emailFrom = (args: unknown): string | null => {
  const data = (args as { data?: { email?: unknown } } | undefined)?.data
  return typeof data?.email === 'string' ? data.email.trim().toLowerCase() : null
}

export const rateLimitAuthOperations: CollectionBeforeOperationHook = async ({
  args,
  operation,
  req,
  context,
}) => {
  if ((operation !== 'login' && operation !== 'forgotPassword') || req.payloadAPI === 'local') {
    return args
  }

  const attempt: AuthAttempt = { operation, email: emailFrom(args) }
  context.marmotAuthAttempt = attempt

  const { ip } = await requestMeta(req.payload, req)
  const key = ip ? `ip:${ip}` : attempt.email ? `email:${attempt.email}` : null
  if (!key) return args

  const decision = await limiterFor[operation].consume(key)
  if (!decision.allowed) {
    // `routeError` merges `req.responseHeaders` into the error response.
    req.responseHeaders = new Headers({
      ...Object.fromEntries(req.responseHeaders ?? []),
      ...rateLimitHeaders(decision),
    })
    throw new APIError('Too many attempts. Please try again later.', 429, null, true)
  }
  return args
}

/**
 * Successful password or session login (also covers the Local API). The row joins the login's
 * transaction (`req`): the login has already updated the user row, and an insert referencing it
 * from another transaction would wait on that lock until the login commits — a deadlock.
 */
export const auditLogin: CollectionAfterLoginHook = async ({ req, user }) => {
  await recordRequestAuditEvent(req.payload, req, {
    action: 'auth.login',
    actor: user.id,
    target: `users:${String(user.id)}`,
    req,
  })
}

/**
 * Failed login / rate-limited auth attempt. Runs from Payload's REST error handler, after the
 * request's transaction has been abandoned, so the audit row is written in its own transaction.
 */
export const auditAuthFailure: CollectionAfterErrorHook = async ({ error, req, context }) => {
  const attempt = context.marmotAuthAttempt as AuthAttempt | undefined
  if (!attempt) return
  const status = (error as { status?: number }).status
  const action =
    status === 429
      ? 'auth.rate_limited'
      : attempt.operation === 'login'
        ? 'auth.login_failed'
        : null
  if (!action) return

  const meta = await requestMeta(req.payload, req)
  await recordAuditEvent(req.payload, {
    action,
    ...meta,
    metadata: { email: attempt.email, operation: attempt.operation },
  })
}
