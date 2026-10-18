import { jsonError, resolveOrgRequest } from '@/server/notifications/api'
import { errorText } from '@/server/request-locale'
import { isSlackAppEnabled, slackDisabledResponse } from '@/server/slack/config'
import { slackSettings, uninstall } from '@/server/slack/manage'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ orgId: string }> }

/**
 * GET /api/orgs/:orgId/slack — the organization's Slack app installation and linked Slack users
 * (#129, `integration:read`). Never includes the bot token. 404 while the app is disabled.
 */
export async function GET(request: Request, { params }: RouteContext) {
  if (!isSlackAppEnabled()) return slackDisabledResponse()
  const { orgId } = await params
  const ctx = await resolveOrgRequest(request, orgId, 'integration:read')
  if (ctx instanceof Response) return ctx
  return Response.json(await slackSettings(ctx.payload, ctx.orgId))
}

/**
 * DELETE /api/orgs/:orgId/slack — remove the Slack app (`integration:manage`): revokes the bot
 * token, unlinks every Slack user and ends the channel subscriptions made through it.
 */
export async function DELETE(request: Request, { params }: RouteContext) {
  if (!isSlackAppEnabled()) return slackDisabledResponse()
  const { orgId } = await params
  const ctx = await resolveOrgRequest(request, orgId, 'integration:manage')
  if (ctx instanceof Response) return ctx
  if (!(await uninstall(ctx.payload, ctx.orgId, ctx.user))) {
    return jsonError(404, errorText(request, 'slackNotInstalled'))
  }
  return Response.json({ deleted: true })
}
