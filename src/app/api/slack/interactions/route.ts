import { getPayload } from 'payload'

import config from '@payload-config'
import { readVerifiedSlackRequest } from '@/server/slack/http'
import { handleInteraction, parseInteraction } from '@/server/slack/interactions'

export const dynamic = 'force-dynamic'

/**
 * POST /api/slack/interactions — button clicks and modal submissions of the Slack app (#129):
 * **Acknowledge** and **Check now** on "Slack (app)" alerts, and the `/marmot incident` modal.
 * Signed by Slack like every Slack request (401 otherwise; 404 while the app is disabled).
 */
export async function POST(request: Request) {
  const verified = await readVerifiedSlackRequest(request)
  if (!verified.ok) return verified.response
  const interaction = parseInteraction(verified.body)
  if (!interaction) return Response.json({ error: 'Invalid payload' }, { status: 400 })
  const payload = await getPayload({ config })
  const answer = await handleInteraction(payload, request, interaction)
  return answer ? Response.json(answer) : new Response(null, { status: 200 })
}
