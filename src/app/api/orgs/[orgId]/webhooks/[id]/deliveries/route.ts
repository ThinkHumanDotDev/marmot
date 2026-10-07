import { WEBHOOK_DELIVERY_STATES } from '@/lib/webhooks'
import { listDeliveries, loadOrgEndpoint } from '@/server/webhooks/manage'
import { jsonError, resolveOrgRequest } from '@/server/notifications/api'
import { errorText } from '@/server/request-locale'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ orgId: string; id: string }> }

/**
 * GET /api/orgs/:orgId/webhooks/:id/deliveries?page=&state= — the endpoint's delivery log, newest
 * first, 25 per page (`webhook:read`).
 */
export async function GET(request: Request, { params }: RouteContext) {
  const { orgId, id } = await params
  const ctx = await resolveOrgRequest(request, orgId, 'webhook:read')
  if (ctx instanceof Response) return ctx
  const endpoint = await loadOrgEndpoint(ctx, id)
  if (!endpoint) return jsonError(404, errorText(request, 'webhookNotFound'))

  const search = new URL(request.url).searchParams
  const page = Math.max(1, Number.parseInt(search.get('page') ?? '1', 10) || 1)
  const rawState = search.get('state')
  const state = (WEBHOOK_DELIVERY_STATES as readonly string[]).includes(rawState ?? '')
    ? rawState
    : null
  return Response.json(await listDeliveries(ctx, endpoint, { page, state }))
}
