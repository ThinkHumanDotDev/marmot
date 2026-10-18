import { startInstall } from '@/server/slack/oauth'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ orgId: string }> }

/**
 * GET /api/orgs/:orgId/slack/install — "Add to Slack" (#129): redirects a signed-in member with
 * `integration:manage` to Slack's consent screen (`src/server/slack/oauth.ts`). 404 while the
 * Slack app is disabled.
 */
export async function GET(request: Request, { params }: RouteContext) {
  const { orgId } = await params
  return startInstall(request, orgId)
}
