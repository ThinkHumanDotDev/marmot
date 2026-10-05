import { acceptInviteCode } from '@/server/invites'
import { getRequestContext, unauthorized, withErrors } from '@/server/http'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ code: string }> }

/**
 * POST /api/invite/:code/accept — join the organization behind an invitation token or a
 * shareable invite-link token as the signed-in user.
 */
export const POST = withErrors(async (request: Request, { params }: RouteContext) => {
  const { payload, user } = await getRequestContext(request)
  if (!user) return unauthorized()
  const { code } = await params

  const result = await acceptInviteCode({ payload, code, user })
  return Response.json(result)
})
