import { listIntegrationEvents, loadOrgIntegration } from '@/server/integrations/manage'
import { jsonError, resolveOrgRequest } from '@/server/notifications/api'
import { errorText } from '@/server/request-locale'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ orgId: string; id: string }> }

/**
 * GET /api/orgs/:orgId/integrations/:id/events?page= — the event log, newest first, 25 per page:
 * received payloads (secrets redacted), the rule each alert matched and the action taken
 * (`integration:read`).
 */
export async function GET(request: Request, { params }: RouteContext) {
  const { orgId, id } = await params
  const ctx = await resolveOrgRequest(request, orgId, 'integration:read')
  if (ctx instanceof Response) return ctx
  const integration = await loadOrgIntegration(ctx, id)
  if (!integration) return jsonError(404, errorText(request, 'integrationNotFound'))
  const raw = Number(new URL(request.url).searchParams.get('page'))
  const page = Number.isInteger(raw) && raw > 0 ? Math.min(raw, 1000) : 1
  return Response.json(await listIntegrationEvents(ctx, integration, page))
}
