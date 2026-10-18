import { canInOrg } from '@/access/overrides'
import { listPageMetrics, setPageMetrics } from '@/server/metrics/manage'
import { pageMetricsBody } from '@/server/metrics/schemas'
import {
  errorMessage,
  errorStatus,
  jsonError,
  readJson,
  resolveOrgRequest,
} from '@/server/notifications/api'
import { errorText } from '@/server/request-locale'
import { loadOrgStatusPage } from '@/server/status-pages/http'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ orgId: string; id: string }> }

/**
 * GET /api/orgs/:orgId/status-pages/:id/metrics — the organization's metrics and the ones the page
 * shows, in its display order (`{ metrics, selected }`, #280). `metric:read` and access to the page.
 */
export async function GET(request: Request, { params }: RouteContext) {
  const { orgId, id } = await params
  const ctx = await resolveOrgRequest(request, orgId, 'metric:read')
  if (ctx instanceof Response) return ctx
  try {
    const page = await loadOrgStatusPage(ctx, orgId, id, 0)
    if (!page) return jsonError(404, errorText(request, 'statusPageNotFound'))
    return Response.json(await listPageMetrics(ctx, page))
  } catch (error) {
    return jsonError(errorStatus(error), errorMessage(error, request))
  }
}

/**
 * PUT /api/orgs/:orgId/status-pages/:id/metrics `{ metrics: [id, …] }` — pick and order the page's
 * metrics from the status page builder (#280). `metric:update` and `status-page:update`. Publishing
 * a metric (`visible`) stays a setting of the metric.
 */
export async function PUT(request: Request, { params }: RouteContext) {
  const { orgId, id } = await params
  const ctx = await resolveOrgRequest(request, orgId, 'metric:update')
  if (ctx instanceof Response) return ctx
  if (!(await canInOrg(ctx.payload, ctx.user, ctx.orgId, 'status-page:update'))) {
    return jsonError(403, errorText(request, 'forbidden'))
  }

  const body = await readJson(request)
  if (!body) return jsonError(400, errorText(request, 'invalidJsonBody'))
  const parsed = pageMetricsBody.safeParse(body)
  if (!parsed.success) {
    return jsonError(400, parsed.error.issues[0]?.message ?? errorText(request, 'validationFailed'))
  }
  try {
    const page = await loadOrgStatusPage(ctx, orgId, id, 0)
    if (!page) return jsonError(404, errorText(request, 'statusPageNotFound'))
    return Response.json(await setPageMetrics(ctx, page, parsed.data.metrics.map(String)))
  } catch (error) {
    return jsonError(errorStatus(error), errorMessage(error, request))
  }
}
