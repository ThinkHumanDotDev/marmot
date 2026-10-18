import { getPayload } from 'payload'

import config from '@payload-config'
import { childLogger } from '@/lib/logger'
import { readVerifiedSlackRequest } from '@/server/slack/http'
import { findInstallationByTeam, removeInstallation } from '@/server/slack/installations'

export const dynamic = 'force-dynamic'

const log = childLogger('slack:events')

interface SlackEvent {
  type?: string
  challenge?: string
  team_id?: string
  event?: { type?: string; tokens?: { bot?: string[] } }
}

/**
 * POST /api/slack/events — Slack Events API (#129): answers the URL verification challenge and
 * removes the organization's installation when the app is uninstalled from the workspace
 * (`app_uninstalled`) or its bot token is revoked (`tokens_revoked`). Signed by Slack (401
 * otherwise; 404 while the app is disabled).
 */
export async function POST(request: Request) {
  const verified = await readVerifiedSlackRequest(request)
  if (!verified.ok) return verified.response
  let body: SlackEvent
  try {
    body = JSON.parse(verified.body) as SlackEvent
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 })
  }
  if (body.type === 'url_verification') {
    return Response.json({ challenge: String(body.challenge ?? '') })
  }
  const type = body.event?.type
  const revokedBot = type === 'tokens_revoked' && (body.event?.tokens?.bot?.length ?? 0) > 0
  if (
    body.type === 'event_callback' &&
    body.team_id &&
    (type === 'app_uninstalled' || revokedBot)
  ) {
    const payload = await getPayload({ config })
    const installation = await findInstallationByTeam(payload, body.team_id)
    if (installation) {
      await removeInstallation(payload, installation, { revoke: false })
      log.info({ teamId: body.team_id, type }, 'slack installation removed by slack')
    }
  }
  return new Response(null, { status: 200 })
}
