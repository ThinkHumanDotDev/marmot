import { getRequestContext, parseId, unauthorized, withErrors } from '@/server/http'
import { unlinkConnectedAccount } from '@/server/accounts'

export const dynamic = 'force-dynamic'

type Context = { params: Promise<{ accountId: string }> }

/**
 * DELETE /api/account/accounts/:accountId → `{ unlinked: true }`
 *
 * Unlinks one of the signed-in user's identities. Refused (409) when it is the last sign-in method
 * of an account without a password.
 */
export const DELETE = withErrors(async (request: Request, { params }: Context) => {
  const { payload, user } = await getRequestContext(request)
  if (!user) return unauthorized()
  const { accountId } = await params
  await unlinkConnectedAccount(payload, user, parseId(payload, accountId))
  return Response.json({ unlinked: true })
})
