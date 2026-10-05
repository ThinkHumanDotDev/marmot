import { APIError } from 'payload'

import { getRequestContext, readJson, unauthorized, withErrors } from '@/server/http'

export const dynamic = 'force-dynamic'

/**
 * POST /api/account/password  `{ currentPassword, password }`
 *
 * Payload has no "verify current password" step on update, so the handler re-authenticates with
 * the current password first and only then writes the new one (as the user, so `selfOrSuperadmin`
 * still applies).
 */
export const POST = withErrors(async (request: Request) => {
  const { payload, user } = await getRequestContext(request)
  if (!user) return unauthorized()
  const { currentPassword, password } = await readJson<{
    currentPassword?: unknown
    password?: unknown
  }>(request)

  if (typeof currentPassword !== 'string' || !currentPassword) {
    throw new APIError('Enter your current password.', 400)
  }
  if (typeof password !== 'string' || password.length < 8) {
    throw new APIError('The new password must be at least 8 characters.', 400)
  }

  try {
    await payload.login({
      collection: 'users',
      data: { email: user.email, password: currentPassword },
      depth: 0,
    })
  } catch {
    throw new APIError('Your current password is incorrect.', 401)
  }

  await payload.update({
    collection: 'users',
    id: user.id,
    data: { password },
    depth: 0,
    user,
    overrideAccess: false,
  })
  return Response.json({ updated: true })
})
