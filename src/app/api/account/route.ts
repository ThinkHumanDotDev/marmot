import { APIError } from 'payload'

import { soleOwnerships } from '@/server/members'
import { getRequestContext, readJson, unauthorized, withErrors } from '@/server/http'

export const dynamic = 'force-dynamic'

/**
 * DELETE /api/account  `{ confirm: <email> }`
 *
 * Deletes the signed-in user's own account. Refused while they are the only owner of any
 * organization (transfer or delete it first). Users may not delete themselves through the Payload
 * REST API (`users.access.delete` is superadmin-only), hence this dedicated handler.
 */
export const DELETE = withErrors(async (request: Request) => {
  const { payload, user } = await getRequestContext(request)
  if (!user) return unauthorized()
  const { confirm } = await readJson<{ confirm?: unknown }>(request)
  if (typeof confirm !== 'string' || confirm.trim().toLowerCase() !== user.email.toLowerCase()) {
    throw new APIError('Type your email address to confirm.', 400)
  }

  const blocking = await soleOwnerships(payload, user)
  if (blocking.length > 0) {
    throw new APIError(
      `You are the only owner of ${blocking.map((o) => o.name).join(', ')}. Transfer ownership or delete the organization first.`,
      409,
    )
  }

  await payload.delete({ collection: 'users', id: user.id, depth: 0, overrideAccess: true })

  const cookieName = `${payload.config.cookiePrefix ?? 'payload'}-token`
  return Response.json(
    { deleted: true },
    {
      headers: {
        'Set-Cookie': `${cookieName}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`,
      },
    },
  )
})
