import { getPayload } from 'payload'

import config from '@payload-config'
import { handlePushRequest } from '@/server/push/http'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ token: string; signal: string }> }

/**
 * `ALL /api/push/:token/start|fail|log|:exitCode?msg=…&ping=…&rid=…` — push monitor signals:
 * start a run, report a failure, record a log line, or report an exit code (`0` = success).
 * Same answers as the bare token URL; an unknown signal is a 404.
 */
async function handle(request: Request, { params }: RouteContext): Promise<Response> {
  const { token, signal } = await params
  const payload = await getPayload({ config })
  return handlePushRequest(payload, request, token, signal)
}

export const GET = handle
export const POST = handle
export const PUT = handle
export const PATCH = handle
export const DELETE = handle
export const HEAD = handle
