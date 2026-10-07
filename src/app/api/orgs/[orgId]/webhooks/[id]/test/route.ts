import { loadOrgEndpoint, sendTestEvent } from '@/server/webhooks/manage'
import { errorMessage, errorStatus, jsonError, resolveOrgRequest } from '@/server/notifications/api'
import { errorText } from '@/server/request-locale'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ orgId: string; id: string }> }

/**
 * POST /api/orgs/:orgId/webhooks/:id/test (`webhook:manage`) — sends a signed `webhook.test` event
 * now (one attempt) and returns its delivery log entry.
 */
export async function POST(request: Request, { params }: RouteContext) {
  const { orgId, id } = await params
  const ctx = await resolveOrgRequest(request, orgId, 'webhook:manage')
  if (ctx instanceof Response) return ctx
  const endpoint = await loadOrgEndpoint(ctx, id)
  if (!endpoint) return jsonError(404, errorText(request, 'webhookNotFound'))
  try {
    return Response.json({ delivery: await sendTestEvent(ctx, endpoint) })
  } catch (error) {
    return jsonError(errorStatus(error), errorMessage(error, request))
  }
}
