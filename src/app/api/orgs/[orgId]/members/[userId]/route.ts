import { changeMemberRole, removeMember } from '@/server/members'
import { getRequestContext, parseId, readJson, unauthorized, withErrors } from '@/server/http'
import { auditTarget, recordRequestAuditEvent } from '@/server/security/audit'

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
  await recordRequestAuditEvent(payload, request, {
    action: 'member.role_changed',
    actor: user.id,
    organization: parseId(payload, orgId),
    target: auditTarget('users', member.id),
    metadata: { role: member.role },
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
  await recordRequestAuditEvent(payload, request, {
    action: 'member.removed',
    actor: user.id,
    organization: parseId(payload, orgId),
    target: auditTarget('users', result.removed),
    metadata: { self: result.self },
  })
  return Response.json(result)
})
