import { headersProblem } from '@/server/otel/headers'
import { otelEndpointProblem } from '@/server/otel/endpoint'
import {
  deleteCollector,
  loadOrgCollector,
  toCollectorRow,
  updateCollector,
  updateCollectorSchema,
} from '@/server/otel/manage'
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

/** GET /api/orgs/:orgId/otel-collectors/:id — one collector, header names only. */
export async function GET(request: Request, { params }: RouteContext) {
  const { orgId, id } = await params
  const ctx = await resolveOrgRequest(request, orgId, 'otel-collector:read')
  if (ctx instanceof Response) return ctx
  const collector = await loadOrgCollector(ctx, id)
  if (!collector) return jsonError(404, errorText(request, 'otelCollectorNotFound'))
  return Response.json({ doc: toCollectorRow(collector) })
}

/**
 * PATCH /api/orgs/:orgId/otel-collectors/:id `{ name?, endpoint?, headers?, active?, default? }`
 * (`otel-collector:manage`). `headers` replaces the whole set; `{ name, value: null }` keeps a
 * stored value.
 */
export async function PATCH(request: Request, { params }: RouteContext) {
  const { orgId, id } = await params
  const ctx = await resolveOrgRequest(request, orgId, 'otel-collector:manage')
  if (ctx instanceof Response) return ctx

  const body = await readJson(request)
  if (!body) return jsonError(400, errorText(request, 'invalidJsonBody'))
  const parsed = updateCollectorSchema.safeParse(body)
  if (!parsed.success) {
    return jsonError(400, parsed.error.issues[0]?.message ?? errorText(request, 'validationFailed'))
  }
  const problem =
    (parsed.data.endpoint !== undefined ? otelEndpointProblem(parsed.data.endpoint) : null) ??
    (parsed.data.headers !== undefined ? headersProblem(parsed.data.headers) : null)
  if (problem) return jsonError(400, errorText(request, problem.key, problem.values))

  const collector = await loadOrgCollector(ctx, id)
  if (!collector) return jsonError(404, errorText(request, 'otelCollectorNotFound'))
  try {
    return Response.json({ doc: await updateCollector(ctx, collector, parsed.data) })
  } catch (error) {
    return jsonError(errorStatus(error), errorMessage(error, request))
  }
}

/**
 * DELETE /api/orgs/:orgId/otel-collectors/:id (`otel-collector:manage`). Monitors that used it
 * fall back to the organization's default collector.
 */
export async function DELETE(request: Request, { params }: RouteContext) {
  const { orgId, id } = await params
  const ctx = await resolveOrgRequest(request, orgId, 'otel-collector:manage')
  if (ctx instanceof Response) return ctx
  const collector = await loadOrgCollector(ctx, id)
  if (!collector) return jsonError(404, errorText(request, 'otelCollectorNotFound'))
  try {
    await deleteCollector(ctx, collector)
    return Response.json({ deleted: String(collector.id) })
  } catch (error) {
    return jsonError(errorStatus(error), errorMessage(error, request))
  }
}
