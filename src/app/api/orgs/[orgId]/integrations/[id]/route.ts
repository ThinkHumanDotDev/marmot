import {
  deleteIntegration,
  loadOrgIntegration,
  toIntegrationRow,
  updateIntegration,
  updateIntegrationSchema,
} from '@/server/integrations/manage'
import {
  errorMessage,
  errorStatus,
  jsonError,
  readJson,
  resolveOrgRequest,
} from '@/server/notifications/api'
import { errorText } from '@/server/request-locale'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ orgId: string; id: string }> }

/** GET /api/orgs/:orgId/integrations/:id — one integration, without its token (`integration:read`). */
export async function GET(request: Request, { params }: RouteContext) {
  const { orgId, id } = await params
  const ctx = await resolveOrgRequest(request, orgId, 'integration:read')
  if (ctx instanceof Response) return ctx
  const integration = await loadOrgIntegration(ctx, id)
  if (!integration) return jsonError(404, errorText(request, 'integrationNotFound'))
  return Response.json({ doc: toIntegrationRow(integration) })
}

/** PATCH /api/orgs/:orgId/integrations/:id — name, format, rules, mapping, active (`integration:manage`). */
export async function PATCH(request: Request, { params }: RouteContext) {
  const { orgId, id } = await params
  const ctx = await resolveOrgRequest(request, orgId, 'integration:manage')
  if (ctx instanceof Response) return ctx

  const body = await readJson(request)
  if (!body) return jsonError(400, errorText(request, 'invalidJsonBody'))
  const parsed = updateIntegrationSchema.safeParse(body)
  if (!parsed.success) {
    return jsonError(400, parsed.error.issues[0]?.message ?? errorText(request, 'validationFailed'))
  }
  const integration = await loadOrgIntegration(ctx, id)
  if (!integration) return jsonError(404, errorText(request, 'integrationNotFound'))
  try {
    return Response.json({ doc: await updateIntegration(ctx, integration, parsed.data) })
  } catch (error) {
    return jsonError(errorStatus(error), errorMessage(error, request))
  }
}

/**
 * DELETE /api/orgs/:orgId/integrations/:id — the integration, its alert state and its event log
 * (`integration:manage`). Incidents it opened stay.
 */
export async function DELETE(request: Request, { params }: RouteContext) {
  const { orgId, id } = await params
  const ctx = await resolveOrgRequest(request, orgId, 'integration:manage')
  if (ctx instanceof Response) return ctx
  const integration = await loadOrgIntegration(ctx, id)
  if (!integration) return jsonError(404, errorText(request, 'integrationNotFound'))
  try {
    await deleteIntegration(ctx, integration)
    return Response.json({ deleted: String(integration.id) })
  } catch (error) {
    return jsonError(errorStatus(error), errorMessage(error, request))
  }
}
