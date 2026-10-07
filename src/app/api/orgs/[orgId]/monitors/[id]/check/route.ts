import { getPayload } from 'payload'

import config from '@payload-config'
import { childLogger } from '@/lib/logger'
import { queueMonitorCheck } from '@/server/monitors/activity'
import { authenticate, authorize, jsonError, loadOrgMonitor, parseId } from '@/server/monitors/http'
import { errorText } from '@/server/request-locale'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ orgId: string; id: string }> }

const log = childLogger('monitors:check-now')

/**
 * POST /api/orgs/:orgId/monitors/:id/check — run a check right away (`monitor:update`). The check is
 * queued for the worker and answered `202 { jobId, queuedAt }`; its heartbeat arrives like any other
 * (realtime, `GET …/heartbeats`). Paused monitors answer `409`.
 */
export async function POST(request: Request, { params }: RouteContext) {
  const payload = await getPayload({ config })
  const { orgId: rawOrgId, id: rawId } = await params
  const orgId = parseId(payload, rawOrgId)

  const auth = await authenticate(payload, request)
  if (auth.response) return auth.response
  const forbidden = await authorize(payload, auth.user, orgId, 'monitor:update')
  if (forbidden) return forbidden

  const monitor = await loadOrgMonitor(payload, auth.user, orgId, parseId(payload, rawId))
  if (!monitor) return jsonError(404, errorText(request, 'monitorNotFound'))
  if (!monitor.active) return jsonError(409, errorText(request, 'monitorPaused'))

  try {
    return Response.json(await queueMonitorCheck(monitor), { status: 202 })
  } catch (err) {
    log.error({ err, monitorId: String(monitor.id) }, 'failed to queue a check')
    return jsonError(503, errorText(request, 'checkQueueUnavailable'))
  }
}
