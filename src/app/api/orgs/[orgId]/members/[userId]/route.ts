import { changeMemberRole, removeMember } from '@/server/members'
import { getRequestContext, parseId, readJson, unauthorized, withErrors } from '@/server/http'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ orgId: string; userId: string }> }

/** PATCH /api/orgs/:orgId/members/:userId  `{ role }` — change a member's role. */
export const PATCH = withErrors(async (request: Request, { params }: RouteContext) => {
  const { payload, user } = await getRequestContext(request)
  if (!user) return unauthorized()
  const { orgId, userId } = await params
  const { role } = await readJson<{ role?: unknown }>(request)

  const member = await changeMemberRole({
    payload,
    actor: user,
    orgId: parseId(payload, orgId),
    userId: parseId(payload, userId),
    role,
  })
  return Response.json({ member })
})

/** DELETE /api/orgs/:orgId/members/:userId — remove a member, or leave when it is yourself. */
export const DELETE = withErrors(async (request: Request, { params }: RouteContext) => {
  const { payload, user } = await getRequestContext(request)
  if (!user) return unauthorized()
  const { orgId, userId } = await params

  const result = await removeMember({
    payload,
    actor: user,
    orgId: parseId(payload, orgId),
    userId: parseId(payload, userId),
  })
  return Response.json(result)
})
