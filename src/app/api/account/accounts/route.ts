import { getRequestContext, unauthorized, withErrors } from '@/server/http'
import { listConnectedAccounts } from '@/server/accounts'

export const dynamic = 'force-dynamic'

/**
 * GET /api/account/accounts → `{ accounts, linkable, hasPassword }`
 *
 * The signed-in user's linked single sign-on identities and the providers they could still link
 * (start a link with `GET <loginPath>?link=1&next=/path`).
 */
export const GET = withErrors(async (request: Request) => {
  const { payload, user } = await getRequestContext(request)
  if (!user) return unauthorized()
  return Response.json(await listConnectedAccounts(payload, user), {
    headers: { 'Cache-Control': 'no-store' },
  })
})
