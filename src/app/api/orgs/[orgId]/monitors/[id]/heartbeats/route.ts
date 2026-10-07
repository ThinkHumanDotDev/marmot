import { getPayload } from 'payload'

import config from '@payload-config'
import {
  DEFAULT_HEARTBEATS,
  isHeartbeatStatus,
  listMonitorHeartbeats,
  MAX_HEARTBEATS,
} from '@/server/monitors/activity'
import {
  authenticate,
  authorize,
  jsonError,
  loadOrgMonitor,
  parseId,
  payloadError,
} from '@/server/monitors/http'
import { errorText } from '@/server/request-locale'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ orgId: string; id: string }> }

/**
 * GET /api/orgs/:orgId/monitors/:id/heartbeats — the monitor's latest check results, newest first
 * (`monitor:read`). Query: `limit` (1–500, default 50), `status` (`up`, `down`, `pending`,
 * `maintenance`, `degraded`), `important=true` for status changes only. Raw beats are kept for 24
 * hours, status changes for `KEEP_DATA_PERIOD_DAYS`.
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
  const limit = Number(url.searchParams.get('limit') ?? DEFAULT_HEARTBEATS)
  const status = url.searchParams.get('status')
  try {
    const docs = await listMonitorHeartbeats(payload, monitor, {
      limit: Number.isInteger(limit) && limit > 0 ? Math.min(limit, MAX_HEARTBEATS) : undefined,
      status: isHeartbeatStatus(status) ? status : undefined,
      importantOnly: url.searchParams.get('important') === 'true',
    })
    return Response.json({ docs })
  } catch (error) {
    return payloadError(error, request)
  }
}
