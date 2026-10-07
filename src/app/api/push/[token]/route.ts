import { getPayload } from 'payload'

import config from '@payload-config'
import { handlePushRequest } from '@/server/push/http'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ token: string }> }

/**
 * `ALL /api/push/:token?status=up|down&msg=…&ping=…&rid=…` — heartbeat endpoint for push monitors.
 * Any HTTP method works so curl, cron jobs and webhooks can call it however they like; a request
 * body (first 10 000 bytes) is kept in the monitor's ping log. Answers `{ ok: true }`,
 * `404 { ok: false, msg }` for unknown or paused tokens. Signal paths live in `./[signal]`.
 */
async function handle(request: Request, { params }: RouteContext): Promise<Response> {
  const { token } = await params
  const payload = await getPayload({ config })
  return handlePushRequest(payload, request, token)
}

export const GET = handle
export const POST = handle
export const PUT = handle
export const PATCH = handle
export const DELETE = handle
export const HEAD = handle
