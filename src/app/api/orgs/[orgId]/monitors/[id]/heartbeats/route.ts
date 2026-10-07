import { getPayload, type Where } from 'payload'

import config from '@payload-config'
import { HEARTBEAT_STATUSES } from '@/collections/Heartbeats'
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

const MAX_LIMIT = 500

/**
 * GET /api/orgs/:orgId/monitors/:id/heartbeats — the monitor's latest heartbeats, newest first
 * (`monitor:read`). Query: `limit` (1–500, default 50), `important=true` for status changes only,
 * `status` (`up`, `down`, `pending`, `maintenance`, `degraded`) for one status.
 * Raw beats are kept for 24 hours, important ones for `KEEP_DATA_PERIOD_DAYS`.
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
  const requested = Number(url.searchParams.get('limit'))
  const limit = Number.isInteger(requested) && requested > 0 ? Math.min(requested, MAX_LIMIT) : 50
  const and: Where[] = [{ monitor: { equals: monitor.id } }]
  if (url.searchParams.get('important') === 'true') and.push({ important: { equals: true } })
  const status = url.searchParams.get('status')
  if (status && (HEARTBEAT_STATUSES as readonly string[]).includes(status)) {
    and.push({ status: { equals: status } })
  }

  try {
    // The monitor was loaded as the caller above; heartbeat rows carry no access rules of their own.
    const { docs } = await payload.find({
      collection: 'heartbeats',
      where: { and },
      sort: '-time',
      limit,
      depth: 0,
      overrideAccess: true,
      select: { status: true, msg: true, ping: true, important: true, time: true },
    })
    return Response.json({ docs })
  } catch (error) {
    return payloadError(error, request)
  }
}
