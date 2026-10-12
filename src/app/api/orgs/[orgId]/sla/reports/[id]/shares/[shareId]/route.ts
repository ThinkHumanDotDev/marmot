import {
  errorMessage,
  errorStatus,
  jsonError,
  parseDocId,
  resolveOrgRequest,
} from '@/server/notifications/api'
import { errorText } from '@/server/request-locale'
import { loadOrgReport } from '@/server/sla/manage'
import { revokeShare } from '@/server/sla/shares'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ orgId: string; id: string; shareId: string }> }

/**
 * DELETE /api/orgs/:orgId/sla/reports/:id/shares/:shareId — revoke a public link for good
 * (`sla:manage`). The record stays, stamped `revokedAt`, so the list shows what was shared.
 */
export async function DELETE(request: Request, { params }: RouteContext) {
  const { orgId, id, shareId } = await params
  const ctx = await resolveOrgRequest(request, orgId, 'sla:manage')
  if (ctx instanceof Response) return ctx
  const report = await loadOrgReport(ctx, id)
  if (!report) return jsonError(404, errorText(request, 'slaReportNotFound'))
  try {
    const share = await revokeShare(ctx, report, parseDocId(ctx.payload, shareId))
    if (!share) return jsonError(404, errorText(request, 'slaShareNotFound'))
    return Response.json({ doc: share })
  } catch (error) {
    return jsonError(errorStatus(error), errorMessage(error, request))
  }
}
