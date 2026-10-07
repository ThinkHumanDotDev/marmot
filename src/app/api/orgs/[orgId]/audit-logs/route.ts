import { isSuperadmin } from '@/access/permissions'
import { AUDIT_PAGE_SIZE, listAuditEvents, parseAuditFilters } from '@/server/audit/query'
import { jsonError, resolveOrgRequest } from '@/server/notifications/api'
import { errorText } from '@/server/request-locale'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ orgId: string }> }

/**
 * GET /api/orgs/:orgId/audit-logs — the organization's audit log, newest first
 * (`audit-log:read`, admins and owners by default).
 *
 * Query: `actorType` (user | apiKey | mcp | system), `actorId`, `entityType`, `entityId`, `action`
 * (exact, or a prefix ending in `.` such as `monitor.`), `from` / `to` (ISO date or instant,
 * inclusive), `page`, `limit` (max 200). Superadmins may pass `scope=instance` for rows without an
 * organization (sign-ins, instance settings). Answers `{ docs, page, totalPages, totalDocs,
 * hasNextPage }`; `before`/`after` hold the changed values with secrets redacted.
 */
export async function GET(request: Request, { params }: RouteContext) {
  const { orgId } = await params
  const ctx = await resolveOrgRequest(request, orgId, 'audit-log:read')
  if (ctx instanceof Response) return ctx

  const url = new URL(request.url)
  const parsed = parseAuditFilters(url.searchParams)
  if (!parsed.ok) return jsonError(400, parsed.error)
  if (parsed.filters.scope === 'instance' && !isSuperadmin(ctx.user)) {
    return jsonError(403, errorText(request, 'forbidden'))
  }

  const page = Number.parseInt(url.searchParams.get('page') ?? '1', 10) || 1
  const limit = Number.parseInt(url.searchParams.get('limit') ?? '', 10) || AUDIT_PAGE_SIZE
  const result = await listAuditEvents(ctx.payload, ctx.user, ctx.orgId, parsed.filters, {
    page,
    limit,
  })
  return Response.json(result, { headers: { 'Cache-Control': 'no-store' } })
}
