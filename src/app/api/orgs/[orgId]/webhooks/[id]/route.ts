import {
  deleteEndpoint,
  loadOrgEndpoint,
  updateEndpoint,
  updateEndpointSchema,
} from '@/server/webhooks/manage'
import { toEndpointRow } from '@/server/webhooks/rows'
import { webhookUrlProblem } from '@/server/webhooks/url'
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

/** GET /api/orgs/:orgId/webhooks/:id — one endpoint, without its secret (`webhook:read`). */
export async function GET(request: Request, { params }: RouteContext) {
  const { orgId, id } = await params
  const ctx = await resolveOrgRequest(request, orgId, 'webhook:read')
  if (ctx instanceof Response) return ctx
  const endpoint = await loadOrgEndpoint(ctx, id)
  if (!endpoint) return jsonError(404, errorText(request, 'webhookNotFound'))
  return Response.json({ doc: toEndpointRow(endpoint) })
}

/**
 * PATCH /api/orgs/:orgId/webhooks/:id `{ url?, events?, description?, active? }`
 * (`webhook:manage`). Re-enabling an endpoint resets its failure streak.
 */
export async function PATCH(request: Request, { params }: RouteContext) {
  const { orgId, id } = await params
  const ctx = await resolveOrgRequest(request, orgId, 'webhook:manage')
  if (ctx instanceof Response) return ctx

  const body = await readJson(request)
  if (!body) return jsonError(400, errorText(request, 'invalidJsonBody'))
  const parsed = updateEndpointSchema.safeParse(body)
  if (!parsed.success) {
    return jsonError(400, parsed.error.issues[0]?.message ?? errorText(request, 'validationFailed'))
  }
  if (parsed.data.url !== undefined) {
    const problem = webhookUrlProblem(parsed.data.url)
    if (problem) return jsonError(400, errorText(request, problem.key, problem.values))
  }

  const endpoint = await loadOrgEndpoint(ctx, id)
  if (!endpoint) return jsonError(404, errorText(request, 'webhookNotFound'))
  try {
    return Response.json({ doc: await updateEndpoint(ctx, endpoint, parsed.data) })
  } catch (error) {
    return jsonError(errorStatus(error), errorMessage(error, request))
  }
}

/** DELETE /api/orgs/:orgId/webhooks/:id — the endpoint and its delivery log (`webhook:manage`). */
export async function DELETE(request: Request, { params }: RouteContext) {
  const { orgId, id } = await params
  const ctx = await resolveOrgRequest(request, orgId, 'webhook:manage')
  if (ctx instanceof Response) return ctx
  const endpoint = await loadOrgEndpoint(ctx, id)
  if (!endpoint) return jsonError(404, errorText(request, 'webhookNotFound'))
  try {
    await deleteEndpoint(ctx, endpoint)
    return Response.json({ deleted: String(endpoint.id) })
  } catch (error) {
    return jsonError(errorStatus(error), errorMessage(error, request))
  }
}
