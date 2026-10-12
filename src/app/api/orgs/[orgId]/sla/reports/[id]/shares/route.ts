import {
  errorMessage,
  errorStatus,
  jsonError,
  readJson,
  resolveOrgRequest,
} from '@/server/notifications/api'
import { errorText } from '@/server/request-locale'
import { periodFromDates } from '@/lib/sla'
import { loadOrgReport } from '@/server/sla/manage'
import { createShare, listShares } from '@/server/sla/shares'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ orgId: string; id: string }> }

/** GET /api/orgs/:orgId/sla/reports/:id/shares — the report's public links (`sla:manage`). */
export async function GET(request: Request, { params }: RouteContext) {
  const { orgId, id } = await params
  const ctx = await resolveOrgRequest(request, orgId, 'sla:manage')
  if (ctx instanceof Response) return ctx
  const report = await loadOrgReport(ctx, id)
  if (!report) return jsonError(404, errorText(request, 'slaReportNotFound'))
  return Response.json({ docs: await listShares(ctx, report) })
}

/**
 * POST /api/orgs/:orgId/sla/reports/:id/shares `{ from, to }` (inclusive `YYYY-MM-DD` dates) —
 * create a public read-only link to the report over that range (`sla:manage`). The response
 * carries the link (`url`, `token`) exactly once; only a hash of the token is stored.
 */
export async function POST(request: Request, { params }: RouteContext) {
  const { orgId, id } = await params
  const ctx = await resolveOrgRequest(request, orgId, 'sla:manage')
  if (ctx instanceof Response) return ctx
  const body = await readJson<{ from?: unknown; to?: unknown }>(request)
  if (!body) return jsonError(400, errorText(request, 'invalidJsonBody'))
  const period =
    typeof body.from === 'string' && typeof body.to === 'string'
      ? periodFromDates(body.from, body.to)
      : null
  if (!period) return jsonError(400, errorText(request, 'slaRangeInvalid'))

  const report = await loadOrgReport(ctx, id)
  if (!report) return jsonError(404, errorText(request, 'slaReportNotFound'))
  try {
    const { share, token, url } = await createShare(ctx, report, period)
    return Response.json({ doc: share, token, url }, { status: 201 })
  } catch (error) {
    return jsonError(errorStatus(error), errorMessage(error, request))
  }
}
