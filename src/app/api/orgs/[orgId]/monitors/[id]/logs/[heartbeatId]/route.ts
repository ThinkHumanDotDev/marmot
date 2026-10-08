import { getPayload } from 'payload'

import config from '@payload-config'
import {
  authenticate,
  authorize,
  jsonError,
  loadOrgMonitor,
  parseId,
  payloadError,
} from '@/server/monitors/http'
import { getResponseLogEntry } from '@/server/monitors/response-log'
import { errorText } from '@/server/request-locale'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ orgId: string; id: string; heartbeatId: string }> }

/**
 * GET /api/orgs/:orgId/monitors/:id/logs/:heartbeatId — one check in full (`monitor:read`, #97):
 * status code, response headers, the body of a failed or degraded check, assertion results, timing
 * phases and per-probe results. 404 when the heartbeat is not this monitor's.
 */
export async function GET(request: Request, { params }: RouteContext) {
  const payload = await getPayload({ config })
  const { orgId: rawOrgId, id: rawId, heartbeatId } = await params
  const orgId = parseId(payload, rawOrgId)

  const auth = await authenticate(payload, request)
  if (auth.response) return auth.response
  const forbidden = await authorize(payload, auth.user, orgId, 'monitor:read')
  if (forbidden) return forbidden

  const monitor = await loadOrgMonitor(payload, auth.user, orgId, parseId(payload, rawId))
  if (!monitor) return jsonError(404, errorText(request, 'monitorNotFound'))

  try {
    const entry = await getResponseLogEntry(payload, monitor.id, parseId(payload, heartbeatId))
    if (!entry) return jsonError(404, errorText(request, 'heartbeatNotFound'))
    return Response.json(entry)
  } catch (error) {
    return payloadError(error, request)
  }
}
