import { errorMessage, jsonError, resolveOrgRequest } from '@/server/notifications/api'
import { targetStatuses } from '@/server/sla/compute'
import { listOrgTargets } from '@/server/sla/manage'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ orgId: string }> }

/**
 * GET /api/orgs/:orgId/sla/targets — every SLA target of the organization with its current period:
 * attainment, error budget (seconds), burn rate and the monitor incidents that consumed it
 * (`sla:read`). Targets themselves are created and edited through `/api/sla-targets`.
 */
export async function GET(request: Request, { params }: RouteContext) {
  const { orgId } = await params
  const ctx = await resolveOrgRequest(request, orgId, 'sla:read')
  if (ctx instanceof Response) return ctx
  try {
    return Response.json({ docs: await targetStatuses(ctx.payload, await listOrgTargets(ctx)) })
  } catch (error) {
    return jsonError(500, errorMessage(error, request))
  }
}
