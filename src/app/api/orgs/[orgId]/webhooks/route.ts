import { WEBHOOK_EVENT_GROUPS } from '@/lib/webhook-events'
import { createEndpoint, createEndpointSchema, listEndpoints } from '@/server/webhooks/manage'
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

type RouteContext = { params: Promise<{ orgId: string }> }

/**
 * GET /api/orgs/:orgId/webhooks — the organization's endpoints (without secrets) and the event
 * catalogue (`webhook:read`, admins by default).
 */
export async function GET(request: Request, { params }: RouteContext) {
  const { orgId } = await params
  const ctx = await resolveOrgRequest(request, orgId, 'webhook:read')
  if (ctx instanceof Response) return ctx
  return Response.json({ docs: await listEndpoints(ctx), eventGroups: WEBHOOK_EVENT_GROUPS })
}

/**
 * POST /api/orgs/:orgId/webhooks `{ url, events, description?, active? }` — create an endpoint
 * (`webhook:manage`). The response carries the signing `secret` exactly once.
 */
export async function POST(request: Request, { params }: RouteContext) {
  const { orgId } = await params
  const ctx = await resolveOrgRequest(request, orgId, 'webhook:manage')
  if (ctx instanceof Response) return ctx

  const body = await readJson(request)
  if (!body) return jsonError(400, errorText(request, 'invalidJsonBody'))
  const parsed = createEndpointSchema.safeParse(body)
  if (!parsed.success) {
    return jsonError(400, parsed.error.issues[0]?.message ?? errorText(request, 'validationFailed'))
  }
  const problem = webhookUrlProblem(parsed.data.url)
  if (problem) return jsonError(400, errorText(request, problem.key, problem.values))

  try {
    const { endpoint, secret } = await createEndpoint(ctx, parsed.data)
    return Response.json({ doc: endpoint, secret }, { status: 201 })
  } catch (error) {
    return jsonError(errorStatus(error), errorMessage(error, request))
  }
}
