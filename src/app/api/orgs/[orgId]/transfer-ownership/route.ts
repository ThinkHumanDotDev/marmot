import { transferOwnership } from '@/server/members'
import { getRequestContext, parseId, readJson, unauthorized, withErrors } from '@/server/http'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ orgId: string }> }

/** POST /api/orgs/:orgId/transfer-ownership  `{ userId }` — owner only; the caller becomes admin. */
export const POST = withErrors(async (request: Request, { params }: RouteContext) => {
  const { payload, user } = await getRequestContext(request)
  if (!user) return unauthorized()
  const { orgId } = await params
  const { userId } = await readJson<{ userId?: string | number }>(request)
  if (userId === undefined || userId === null || userId === '') {
    return Response.json({ errors: [{ message: 'userId is required.' }] }, { status: 400 })
  }

  const result = await transferOwnership({
    payload,
    actor: user,
    orgId: parseId(payload, orgId),
    userId: parseId(payload, String(userId)),
  })
  return Response.json(result)
})
