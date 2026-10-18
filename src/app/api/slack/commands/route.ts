import { getPayload } from 'payload'

import config from '@payload-config'
import { handleSlashCommand, parseSlashCommand } from '@/server/slack/commands'
import { readVerifiedSlackRequest } from '@/server/slack/http'

export const dynamic = 'force-dynamic'

/**
 * POST /api/slack/commands — the `/marmot` slash command of the Slack app (#129). Slack signs the
 * request (`X-Slack-Signature`); unsigned, forged or replayed requests get 401, and the route is
 * 404 while the app is disabled. Answers with the command's message (`src/server/slack/commands.ts`),
 * or an empty 200 when a modal was opened instead.
 */
export async function POST(request: Request) {
  const verified = await readVerifiedSlackRequest(request)
  if (!verified.ok) return verified.response
  const command = parseSlashCommand(verified.body)
  if (!command) return Response.json({ error: 'Invalid command' }, { status: 400 })
  const payload = await getPayload({ config })
  const reply = await handleSlashCommand(payload, command)
  if (Object.keys(reply).length === 0) return new Response(null, { status: 200 })
  return Response.json(reply, { headers: { 'Cache-Control': 'no-store' } })
}
