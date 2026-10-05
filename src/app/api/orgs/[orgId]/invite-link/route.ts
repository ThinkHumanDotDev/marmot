import { disableInviteLink, regenerateInviteLink } from '@/server/invites'
import { getRequestContext, parseId, readJson, unauthorized, withErrors } from '@/server/http'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ orgId: string }> }

/** POST /api/orgs/:orgId/invite-link  `{ role? }` — (re)generate the shareable invite link. */
export const POST = withErrors(async (request: Request, { params }: RouteContext) => {
  const { payload, user } = await getRequestContext(request)
  if (!user) return unauthorized()
  const { orgId } = await params
  const { role } = await readJson<{ role?: unknown }>(request)

  const link = await regenerateInviteLink({
    payload,
    actor: user,
    orgId: parseId(payload, orgId),
    role,
  })
  return Response.json(link)
})

/** DELETE /api/orgs/:orgId/invite-link — disable the shareable invite link. */
export const DELETE = withErrors(async (request: Request, { params }: RouteContext) => {
  const { payload, user } = await getRequestContext(request)
  if (!user) return unauthorized()
  const { orgId } = await params

  await disableInviteLink({ payload, actor: user, orgId: parseId(payload, orgId) })
  return Response.json({ disabled: true })
})
