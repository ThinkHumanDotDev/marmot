import { isSuperadmin } from '@/access/permissions'
import { auditEventsToCsv, exportAuditEvents, parseAuditFilters } from '@/server/audit/query'
import { jsonError, resolveOrgRequest } from '@/server/notifications/api'
import { errorText } from '@/server/request-locale'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ orgId: string }> }

/**
 * GET /api/orgs/:orgId/audit-logs/export — the filtered audit log as CSV (same filters and
 * permission as `GET /api/orgs/:orgId/audit-logs`, at most 10 000 rows, newest first).
 */
export async function GET(request: Request, { params }: RouteContext) {
  const { orgId } = await params
  const ctx = await resolveOrgRequest(request, orgId, 'audit-log:read')
  if (ctx instanceof Response) return ctx

  const parsed = parseAuditFilters(new URL(request.url).searchParams)
  if (!parsed.ok) return jsonError(400, parsed.error)
  if (parsed.filters.scope === 'instance' && !isSuperadmin(ctx.user)) {
    return jsonError(403, errorText(request, 'forbidden'))
  }

  const rows = await exportAuditEvents(ctx.payload, ctx.user, ctx.orgId, parsed.filters)
  const stamp = new Date().toISOString().slice(0, 10)
  return new Response(auditEventsToCsv(rows), {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="audit-log-${String(ctx.orgId)}-${stamp}.csv"`,
      'Cache-Control': 'no-store',
    },
  })
}
