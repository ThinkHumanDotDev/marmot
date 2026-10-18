import { errorMessage, jsonError, resolveOrgRequest } from '@/server/notifications/api'
import { errorText } from '@/server/request-locale'
import { getOrganizationI18n } from '@/server/i18n'
import { buildSlaReport } from '@/server/sla/compute'
import {
  loadOrgReport,
  rangeFromSearchParams,
  reportFormatOf,
  reportResponse,
} from '@/server/sla/manage'
import { loadSlaZone } from '@/server/sla/zone'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ orgId: string; id: string }> }

/**
 * GET /api/orgs/:orgId/sla/reports/:id?from=YYYY-MM-DD&to=YYYY-MM-DD[&format=csv|pdf] — the report
 * over a range of days in the organization's time zone (default: the previous calendar month): per target uptime, downtime,
 * incident count, MTTR and whether the target was met (`sla:read`).
 */
export async function GET(request: Request, { params }: RouteContext) {
  const { orgId, id } = await params
  const ctx = await resolveOrgRequest(request, orgId, 'sla:read')
  if (ctx instanceof Response) return ctx
  const url = new URL(request.url)
  const format = reportFormatOf(url.searchParams.get('format'))
  const zone = await loadSlaZone(ctx.payload, ctx.orgId)
  const period = rangeFromSearchParams(url.searchParams, new Date(), zone)
  if (!format || !period) return jsonError(400, errorText(request, 'slaRangeInvalid'))

  const report = await loadOrgReport(ctx, id)
  if (!report) return jsonError(404, errorText(request, 'slaReportNotFound'))
  try {
    const data = await buildSlaReport(ctx.payload, report, period)
    const i18n = await getOrganizationI18n(ctx.payload, ctx.orgId)
    return reportResponse(data, format, i18n, 'private, no-store')
  } catch (error) {
    return jsonError(500, errorMessage(error, request))
  }
}
