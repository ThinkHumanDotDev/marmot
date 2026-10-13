import {
  integrationEndpoints,
  loadOrgIntegration,
  rotateIntegrationToken,
} from '@/server/integrations/manage'
import { errorMessage, errorStatus, jsonError, resolveOrgRequest } from '@/server/notifications/api'
import { errorText } from '@/server/request-locale'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ orgId: string; id: string }> }

/**
 * POST /api/orgs/:orgId/integrations/:id/rotate-token (`integration:manage`) — a new token, shown
 * once with its `url` and `email`; the old one stops working at once.
 */
export async function POST(request: Request, { params }: RouteContext) {
  const { orgId, id } = await params
  const ctx = await resolveOrgRequest(request, orgId, 'integration:manage')
  if (ctx instanceof Response) return ctx
  const integration = await loadOrgIntegration(ctx, id)
  if (!integration) return jsonError(404, errorText(request, 'integrationNotFound'))
  try {
    const rotated = await rotateIntegrationToken(ctx, integration)
    return Response.json({
      doc: rotated.integration,
      token: rotated.token,
      ...integrationEndpoints(rotated.token),
    })
  } catch (error) {
    return jsonError(errorStatus(error), errorMessage(error, request))
  }
}
