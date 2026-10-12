import { createMetric, listMetrics } from '@/server/metrics/manage'
import { metricCreateSchema } from '@/server/metrics/schemas'
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

/** GET /api/orgs/:orgId/metrics — the organization's custom metrics (`metric:read`, #155). */
export async function GET(request: Request, { params }: RouteContext) {
  const { orgId } = await params
  const ctx = await resolveOrgRequest(request, orgId, 'metric:read')
  if (ctx instanceof Response) return ctx
  return Response.json({ docs: await listMetrics(ctx) })
}

/**
 * POST /api/orgs/:orgId/metrics `{ name, suffix?, decimals?, aggregation?, defaultView?,
 * thresholds?, source?, monitor?, visible?, statusPages?, order? }` (`metric:create`).
 */
export async function POST(request: Request, { params }: RouteContext) {
  const { orgId } = await params
  const ctx = await resolveOrgRequest(request, orgId, 'metric:create')
  if (ctx instanceof Response) return ctx

  const body = await readJson(request)
  if (!body) return jsonError(400, errorText(request, 'invalidJsonBody'))
  const parsed = metricCreateSchema.safeParse(body)
  if (!parsed.success) {
    return jsonError(400, parsed.error.issues[0]?.message ?? errorText(request, 'validationFailed'))
  }
  try {
    return Response.json({ doc: await createMetric(ctx, parsed.data) }, { status: 201 })
  } catch (error) {
    return jsonError(errorStatus(error), errorMessage(error, request))
  }
}
