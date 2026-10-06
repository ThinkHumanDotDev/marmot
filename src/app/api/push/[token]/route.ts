import { getPayload } from 'payload'

import config from '@payload-config'
import { handlePush } from '@/server/push'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ token: string }> }

/**
 * `ALL /api/push/:token?status=up|down&msg=…&ping=…` — heartbeat endpoint for push monitors.
 * Any HTTP method works so curl, cron jobs and webhooks can call it however they like.
 * Answers `{ ok: true }`, `404 { ok: false, msg }` for unknown or paused tokens.
 */
async function handle(request: Request, { params }: RouteContext): Promise<Response> {
  const { token } = await params
  const url = new URL(request.url)
  const payload = await getPayload({ config })

  const outcome = await handlePush(payload, token, {
    status: url.searchParams.get('status'),
    msg: url.searchParams.get('msg'),
    ping: url.searchParams.get('ping'),
  })

  const headers = { 'Cache-Control': 'no-store' }
  if (!outcome.ok) {
    return Response.json({ ok: false, msg: outcome.msg }, { status: outcome.status, headers })
  }
  return Response.json({ ok: true }, { headers })
}

export const GET = handle
export const POST = handle
export const PUT = handle
export const PATCH = handle
export const DELETE = handle
export const HEAD = handle
