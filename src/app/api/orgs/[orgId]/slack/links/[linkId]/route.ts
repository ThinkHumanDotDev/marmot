import { jsonError, parseDocId, resolveOrgRequest } from '@/server/notifications/api'
import { errorText } from '@/server/request-locale'
import { isSlackAppEnabled, slackDisabledResponse } from '@/server/slack/config'
import { removeLink } from '@/server/slack/manage'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ orgId: string; linkId: string }> }

/** DELETE /api/orgs/:orgId/slack/links/:linkId — unlink a Slack user (#129, `integration:manage`). */
export async function DELETE(request: Request, { params }: RouteContext) {
  if (!isSlackAppEnabled()) return slackDisabledResponse()
  const { orgId, linkId } = await params
  const ctx = await resolveOrgRequest(request, orgId, 'integration:manage')
  if (ctx instanceof Response) return ctx
  const removed = await removeLink(
    ctx.payload,
    ctx.orgId,
    parseDocId(ctx.payload, linkId),
    ctx.user,
  )
  if (!removed) return jsonError(404, errorText(request, 'slackLinkNotFound'))
  return Response.json({ deleted: true })
}
