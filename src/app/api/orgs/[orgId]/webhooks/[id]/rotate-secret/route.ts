import { loadOrgEndpoint, rotateSecret } from '@/server/webhooks/manage'
import { errorMessage, errorStatus, jsonError, resolveOrgRequest } from '@/server/notifications/api'
import { errorText } from '@/server/request-locale'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ orgId: string; id: string }> }

/**
 * POST /api/orgs/:orgId/webhooks/:id/rotate-secret (`webhook:manage`) — a new signing secret,
 * returned once. The previous secret keeps signing next to it for 24 hours.
 */
export async function POST(request: Request, { params }: RouteContext) {
  const { orgId, id } = await params
  const ctx = await resolveOrgRequest(request, orgId, 'webhook:manage')
  if (ctx instanceof Response) return ctx
  const endpoint = await loadOrgEndpoint(ctx, id)
  if (!endpoint) return jsonError(404, errorText(request, 'webhookNotFound'))
  try {
    const { endpoint: doc, secret } = await rotateSecret(ctx, endpoint)
    return Response.json({ doc, secret })
  } catch (error) {
    return jsonError(errorStatus(error), errorMessage(error, request))
  }
}
