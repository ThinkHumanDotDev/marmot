import { finishInstall } from '@/server/slack/oauth'

export const dynamic = 'force-dynamic'

/**
 * GET /api/slack/oauth/callback?code&state — Slack's redirect after "Add to Slack" (#129). Checks
 * the signed state against the cookie and the signed-in member, exchanges the code for the bot
 * token and redirects to Settings → Integrations (`src/server/slack/oauth.ts`).
 */
export async function GET(request: Request) {
  return finishInstall(request)
}
