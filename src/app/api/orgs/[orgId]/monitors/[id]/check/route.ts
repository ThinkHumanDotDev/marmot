import { getPayload } from 'payload'

import config from '@payload-config'
import { isRemoteMonitor } from '@/lib/probe-locations'
import { supportsCheckNow } from '@/lib/on-demand-check'
import {
  enqueueOnDemandCheck,
  onDemandWaitMs,
  waitForOnDemandCheck,
} from '@/server/engine/on-demand'
import { MANUAL_CHECK_JOB_NAME } from '@/server/engine/names'
import {
  consumeCheckBudget,
  outcomeResponse,
  queryFlag,
  resolveCheckActor,
} from '@/server/monitors/checks'
import { jsonError, loadOrgMonitor, parseId } from '@/server/monitors/http'
import { errorText } from '@/server/request-locale'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ orgId: string; id: string }> }

/**
 * POST /api/orgs/:orgId/monitors/:id/check — run the monitor's check now ("Check now").
 *
 * The worker runs the check (outbound address guard and proxies apply as for scheduled checks);
 * concurrent requests for the same monitor share one job. By default the request waits up to the
 * monitor timeout and answers with the result (`OnDemandCheckResult`): status, message, ping, HTTP
 * status code, TLS summary, type-specific details. The heartbeat is stored with `trigger: manual`
 * and feeds the state machine (and so realtime, stats and notifications) like any other beat.
 *
 * Query: `wait=false` answers `202 { jobId }` at once (the heartbeat arrives over realtime);
 * `record=false` runs the check without storing a heartbeat or touching the monitor's state.
 *
 * Needs `monitor:update`; rate-limited per organization (`ON_DEMAND_CHECKS_PER_MINUTE`). Paused
 * and push monitors answer 409, as do recorded checks of monitors checked by a probe location.
 */
export async function POST(request: Request, { params }: RouteContext) {
  const payload = await getPayload({ config })
  const { orgId: rawOrgId, id: rawId } = await params
  const orgId = parseId(payload, rawOrgId)
  const id = parseId(payload, rawId)

  const resolved = await resolveCheckActor(payload, request, orgId, ['monitor:update'])
  if (resolved.response) return resolved.response
  const { actor } = resolved

  const monitor = await loadOrgMonitor(payload, actor.user, orgId, id)
  if (!monitor) return jsonError(404, errorText(request, 'monitorNotFound'))
  if (!supportsCheckNow(monitor.type)) {
    return jsonError(409, errorText(request, 'checkNotApplicable'))
  }
  if (!monitor.active) return jsonError(409, errorText(request, 'monitorPausedNoCheck'))
  const record = queryFlag(request, 'record', true)
  // Probe-checked monitors (#91): a beat recorded from this server would mix two vantage points
  // into one state machine. Dry runs (`record=false`) still test the target from here.
  if (record && isRemoteMonitor(monitor)) {
    return jsonError(409, errorText(request, 'checkOnProbe'))
  }

  const budget = await consumeCheckBudget(request, orgId)
  if (budget.response) return budget.response

  const wait = queryFlag(request, 'wait', true)
  const waitMs = onDemandWaitMs(monitor)
  const monitorId = String(monitor.id)

  let job
  try {
    job = await enqueueOnDemandCheck(
      {
        name: MANUAL_CHECK_JOB_NAME,
        data: { monitorId, record, deadline: Date.now() + waitMs },
        // A dry run must not be answered with a recorded run's result, and vice versa.
        dedupeKey: `manual-${monitorId}-${record ? 'record' : 'dry'}`,
      },
      waitMs,
    )
  } catch {
    return jsonError(503, errorText(request, 'checkFailed'))
  }

  if (!wait) {
    return Response.json(
      { jobId: job.id, monitorId, status: 'queued' },
      { status: 202, headers: budget.headers },
    )
  }
  return outcomeResponse(request, await waitForOnDemandCheck(job, waitMs), budget.headers)
}
