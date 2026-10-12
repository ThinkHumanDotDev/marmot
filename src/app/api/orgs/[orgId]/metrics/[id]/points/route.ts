import { isMetricView, METRIC_VIEWS } from '@/lib/metrics'
import { loadOrgMetric } from '@/server/metrics/manage'
import { handlePush } from '@/server/metrics/push-http'
import { readMetricSeries } from '@/server/metrics/series'
import { jsonError, resolveOrgRequest } from '@/server/notifications/api'
import { errorText } from '@/server/request-locale'
import { metricPushLimiter } from '@/server/security/limiters'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ orgId: string; id: string }> }

/**
 * GET /api/orgs/:orgId/metrics/:id/points?view=hour|day|week|month — the metric's chart as the
 * status page draws it, whether or not it is published (`metric:read`).
 */
export async function GET(request: Request, { params }: RouteContext) {
  const { orgId, id } = await params
  const ctx = await resolveOrgRequest(request, orgId, 'metric:read')
  if (ctx instanceof Response) return ctx
  const metric = await loadOrgMetric(ctx, id)
  if (!metric) return jsonError(404, errorText(request, 'metricNotFound'))
  const view = new URL(request.url).searchParams.get('view') ?? metric.defaultView ?? 'day'
  if (!isMetricView(view)) {
    return jsonError(
      400,
      errorText(request, 'metricViewInvalid', { views: METRIC_VIEWS.join(', ') }),
    )
  }
  return Response.json(await readMetricSeries(ctx.payload, metric, view))
}

/** POST /api/orgs/:orgId/metrics/:id/points — push points (`src/server/metrics/push-http.ts`). */
export async function POST(request: Request, { params }: RouteContext) {
  const { orgId, id } = await params
  return handlePush(request, orgId, id, metricPushLimiter)
}
