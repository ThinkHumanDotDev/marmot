import { headersProblem } from '@/server/otel/headers'
import { otelEndpointProblem } from '@/server/otel/endpoint'
import { createCollector, createCollectorSchema, listCollectors } from '@/server/otel/manage'
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
 * GET /api/orgs/:orgId/otel-collectors — the organization's OpenTelemetry collectors, with header
 * names but never their values (`otel-collector:read`, members by default).
 */
export async function GET(request: Request, { params }: RouteContext) {
  const { orgId } = await params
  const ctx = await resolveOrgRequest(request, orgId, 'otel-collector:read')
  if (ctx instanceof Response) return ctx
  return Response.json({ docs: await listCollectors(ctx) })
}

/**
 * POST /api/orgs/:orgId/otel-collectors `{ name, endpoint, headers?, active?, default? }`
 * (`otel-collector:manage`, admins by default). Header values are sealed and write-only.
 */
export async function POST(request: Request, { params }: RouteContext) {
  const { orgId } = await params
  const ctx = await resolveOrgRequest(request, orgId, 'otel-collector:manage')
  if (ctx instanceof Response) return ctx

  const body = await readJson(request)
  if (!body) return jsonError(400, errorText(request, 'invalidJsonBody'))
  const parsed = createCollectorSchema.safeParse(body)
  if (!parsed.success) {
    return jsonError(400, parsed.error.issues[0]?.message ?? errorText(request, 'validationFailed'))
  }
  const problem =
    otelEndpointProblem(parsed.data.endpoint) ?? headersProblem(parsed.data.headers ?? [])
  if (problem) return jsonError(400, errorText(request, problem.key, problem.values))

  try {
    return Response.json({ doc: await createCollector(ctx, parsed.data) }, { status: 201 })
  } catch (error) {
    return jsonError(errorStatus(error), errorMessage(error, request))
  }
}
