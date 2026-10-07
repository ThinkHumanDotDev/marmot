import { loadEndpointDelivery, loadOrgEndpoint, redeliver } from '@/server/webhooks/manage'
import { errorMessage, errorStatus, jsonError, resolveOrgRequest } from '@/server/notifications/api'
import { errorText } from '@/server/request-locale'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ orgId: string; id: string; deliveryId: string }> }

/**
 * POST /api/orgs/:orgId/webhooks/:id/deliveries/:deliveryId/redeliver (`webhook:manage`) — sends
 * the logged event again now (same event id, new delivery id) and returns the new log entry.
 */
export async function POST(request: Request, { params }: RouteContext) {
  const { orgId, id, deliveryId } = await params
  const ctx = await resolveOrgRequest(request, orgId, 'webhook:manage')
  if (ctx instanceof Response) return ctx
  const endpoint = await loadOrgEndpoint(ctx, id)
  if (!endpoint) return jsonError(404, errorText(request, 'webhookNotFound'))
  const original = await loadEndpointDelivery(ctx, endpoint, deliveryId)
  if (!original) return jsonError(404, errorText(request, 'webhookDeliveryNotFound'))
  try {
    return Response.json({ delivery: await redeliver(ctx, endpoint, original) }, { status: 201 })
  } catch (error) {
    return jsonError(errorStatus(error), errorMessage(error, request))
  }
}
