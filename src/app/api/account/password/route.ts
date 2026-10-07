import { verifyPassword } from '@/auth/password'
import { getRequestContext, readJson, unauthorized, withErrors } from '@/server/http'
import { recordUserAuditEvent } from '@/server/security/audit'
import { apiError } from '@/server/errors'

export const dynamic = 'force-dynamic'

/**
 * POST /api/account/password  `{ currentPassword, password }`
 *
 * Payload has no "verify current password" step on update, so the handler re-authenticates with
 * the current password first (`verifyPassword`, which leaves no extra session behind) and only
 * then writes the new one (as the user, so `selfOrSuperadmin` still applies).
 */
export const POST = withErrors(async (request: Request) => {
  const { payload, user } = await getRequestContext(request)
  if (!user) return unauthorized(request)
  const { currentPassword, password } = await readJson<{
    currentPassword?: unknown
    password?: unknown
  }>(request)

  if (typeof currentPassword !== 'string' || !currentPassword) {
    throw apiError('enterCurrentPassword', 400)
  }
  if (typeof password !== 'string' || password.length < 8) {
    throw apiError('passwordTooShort', 400, { min: 8 })
  }

  if (!(await verifyPassword(payload, user.email, currentPassword))) {
    throw apiError('currentPasswordIncorrect', 401)
  }

  await payload.update({
    collection: 'users',
    id: user.id,
    data: { password },
    depth: 0,
    user,
    overrideAccess: false,
  })
  await recordUserAuditEvent(payload, request, user, 'auth.password_changed')
  return Response.json({ updated: true })
})
