import { deleteMetric, loadOrgMetric, toMetricRow, updateMetric } from '@/server/metrics/manage'
import { metricUpdateSchema } from '@/server/metrics/schemas'
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

/** GET /api/orgs/:orgId/metrics/:id — one custom metric (`metric:read`). */
export async function GET(request: Request, { params }: RouteContext) {
  const { orgId, id } = await params
  const ctx = await resolveOrgRequest(request, orgId, 'metric:read')
  if (ctx instanceof Response) return ctx
  const metric = await loadOrgMetric(ctx, id)
  if (!metric) return jsonError(404, errorText(request, 'metricNotFound'))
  return Response.json({ doc: toMetricRow(metric) })
}

/** PATCH /api/orgs/:orgId/metrics/:id — partial update (`metric:update`). */
export async function PATCH(request: Request, { params }: RouteContext) {
  const { orgId, id } = await params
  const ctx = await resolveOrgRequest(request, orgId, 'metric:update')
  if (ctx instanceof Response) return ctx

  const body = await readJson(request)
  if (!body) return jsonError(400, errorText(request, 'invalidJsonBody'))
  const parsed = metricUpdateSchema.safeParse(body)
  if (!parsed.success) {
    return jsonError(400, parsed.error.issues[0]?.message ?? errorText(request, 'validationFailed'))
  }
  const metric = await loadOrgMetric(ctx, id)
  if (!metric) return jsonError(404, errorText(request, 'metricNotFound'))
  try {
    return Response.json({ doc: await updateMetric(ctx, metric, parsed.data) })
  } catch (error) {
    return jsonError(errorStatus(error), errorMessage(error, request))
  }
}

/** DELETE /api/orgs/:orgId/metrics/:id — the metric and its rollups (`metric:delete`). */
export async function DELETE(request: Request, { params }: RouteContext) {
  const { orgId, id } = await params
  const ctx = await resolveOrgRequest(request, orgId, 'metric:delete')
  if (ctx instanceof Response) return ctx
  const metric = await loadOrgMetric(ctx, id)
  if (!metric) return jsonError(404, errorText(request, 'metricNotFound'))
  try {
    await deleteMetric(ctx, metric)
    return Response.json({ deleted: String(metric.id) })
  } catch (error) {
    return jsonError(errorStatus(error), errorMessage(error, request))
  }
}
