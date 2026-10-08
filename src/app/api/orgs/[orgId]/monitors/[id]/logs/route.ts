import { getPayload } from 'payload'

import config from '@payload-config'
import { LOG_PAGE_SIZE } from '@/lib/response-log'
import {
  authenticate,
  authorize,
  jsonError,
  loadOrgMonitor,
  parseId,
  payloadError,
} from '@/server/monitors/http'
import {
  decodeCursor,
  listResponseLog,
  parseResponseLogFilters,
} from '@/server/monitors/response-log'
import { errorText } from '@/server/request-locale'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ orgId: string; id: string }> }

/**
 * GET /api/orgs/:orgId/monitors/:id/logs — the monitor's per-check log, newest first
 * (`monitor:read`, #97). Query: `status` (one or a comma-separated list), `statusCode` (`503` or
 * `5xx`), `trigger` (`schedule` | `manual`), `from` / `to` (ISO instants), `location` (a location id
 * or `local`, #92), `limit` (1–200, default 50) and `cursor` (the previous page's `nextCursor`). Rows follow the heartbeat retention: 24 hours,
 * status changes for `KEEP_DATA_PERIOD_DAYS`.
 */
export async function GET(request: Request, { params }: RouteContext) {
  const payload = await getPayload({ config })
  const { orgId: rawOrgId, id: rawId } = await params
  const orgId = parseId(payload, rawOrgId)

  const auth = await authenticate(payload, request)
  if (auth.response) return auth.response
  const forbidden = await authorize(payload, auth.user, orgId, 'monitor:read')
  if (forbidden) return forbidden

  const monitor = await loadOrgMonitor(payload, auth.user, orgId, parseId(payload, rawId))
  if (!monitor) return jsonError(404, errorText(request, 'monitorNotFound'))

  const url = new URL(request.url)
  const parsed = parseResponseLogFilters(url.searchParams)
  if (!parsed.ok) return jsonError(400, errorText(request, 'validationFailed'), parsed.error)
  const rawCursor = url.searchParams.get('cursor')
  const cursor = rawCursor ? decodeCursor(rawCursor) : null
  if (rawCursor && !cursor) {
    return jsonError(400, errorText(request, 'validationFailed'), 'cursor: invalid')
  }
  const limit = Number(url.searchParams.get('limit') ?? LOG_PAGE_SIZE)

  try {
    return Response.json(
      await listResponseLog(payload, monitor.id, parsed.filters, { cursor, limit }),
    )
  } catch (error) {
    return payloadError(error, request)
  }
}
