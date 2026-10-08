import {
  isUnverified,
  emailVerificationLimiter,
  sendVerificationEmail,
} from '@/server/auth/email-verification'
import { childLogger } from '@/lib/logger'
import { getRequestContext, localizedError, unauthorized, withErrors } from '@/server/http'
import { rateLimitHeaders, tooManyRequests } from '@/server/security/rate-limit'
import { isEmailVerificationRequired } from '@/server/settings'

export const dynamic = 'force-dynamic'

const log = childLogger('email-verification')

/**
 * POST /api/auth/verify-email/resend → `{ sent: true }` (or `{ sent: false }` when there is nothing
 * to confirm)
 *
 * Mails the signed-in user a new verification link, revoking the previous one. Limited like
 * password reset mails (`EMAIL_VERIFICATION_RATE_LIMIT`, per account): 429 with `Retry-After`.
 */
export const POST = withErrors(async (request: Request) => {
  const { payload, user } = await getRequestContext(request)
  if (!user) return unauthorized(request)
  if (!isUnverified(user) || !(await isEmailVerificationRequired(payload))) {
    return Response.json({ sent: false })
  }

  const decision = await emailVerificationLimiter.consume(`user:${String(user.id)}`)
  if (!decision.allowed) return tooManyRequests(decision, request)

  try {
    await sendVerificationEmail(payload, user, { request, reason: 'resend' })
  } catch (error) {
    log.error({ err: error, user: user.id }, 'failed to resend the verification email')
    return localizedError(request, 'unexpected', 502)
  }
  return Response.json({ sent: true }, { headers: rateLimitHeaders(decision) })
})
