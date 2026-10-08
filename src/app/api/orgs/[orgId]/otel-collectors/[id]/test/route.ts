import { env } from '@/env'
import { loadOrgCollector, sendTestExport } from '@/server/otel/manage'
import { errorMessage, errorStatus, jsonError, resolveOrgRequest } from '@/server/notifications/api'
import { errorText } from '@/server/request-locale'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ orgId: string; id: string }> }

/**
 * POST /api/orgs/:orgId/otel-collectors/:id/test (`otel-collector:manage`) — sends one
 * `marmot.collector.test` data point now (one attempt) and returns `{ ok, status, error }`.
 */
export async function POST(request: Request, { params }: RouteContext) {
  const { orgId, id } = await params
  const ctx = await resolveOrgRequest(request, orgId, 'otel-collector:manage')
  if (ctx instanceof Response) return ctx
  const collector = await loadOrgCollector(ctx, id)
  if (!collector) return jsonError(404, errorText(request, 'otelCollectorNotFound'))
  try {
    const result = await sendTestExport(ctx, collector, env.OTLP_EXPORT_TIMEOUT_MS)
    return Response.json({ ok: result.ok, status: result.status, error: result.error })
  } catch (error) {
    return jsonError(errorStatus(error), errorMessage(error, request))
  }
}
