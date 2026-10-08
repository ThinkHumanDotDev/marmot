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
import { periodDays } from '@/lib/entitlements'
import { assertOrgRetention } from '@/server/billing/entitlements'
import { errorText } from '@/server/request-locale'
import { getRangeStats } from '@/server/stats/range-stats'
import { isStatsRange, STATS_RANGES } from '@/server/stats/uptime-calculator'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ orgId: string; id: string }> }

/**
 * GET /api/orgs/:orgId/monitors/:id/stats?range=24h|1d|7d|14d|30d|90d|1y — uptime (0..1), average
 * response time, degraded checks, latency percentiles, check counts, the chart series and the
 * buckets of the range (`monitor:read`). The same figures as the dashboard (#95). With billing on, a
 * range longer than the plan's `retentionDays` answers 402.
 */
export async function GET(request: Request, { params }: RouteContext) {
  const payload = await getPayload({ config })
  const { orgId: rawOrgId, id: rawId } = await params
  const orgId = parseId(payload, rawOrgId)

  const auth = await authenticate(payload, request)
  if (auth.response) return auth.response
  const forbidden = await authorize(payload, auth.user, orgId, 'monitor:read')
  if (forbidden) return forbidden

  const range = new URL(request.url).searchParams.get('range') ?? '24h'
  if (!isStatsRange(range)) {
    return jsonError(
      400,
      errorText(request, 'statsRangeInvalid', { ranges: STATS_RANGES.join(', ') }),
    )
  }

  const monitor = await loadOrgMonitor(payload, auth.user, orgId, parseId(payload, rawId))
  if (!monitor) return jsonError(404, errorText(request, 'monitorNotFound'))

  try {
    // Never a period longer than the history the organization's plan keeps (#161).
    await assertOrgRetention(payload, orgId, periodDays(range))
    return Response.json(await getRangeStats(payload, monitor.id, range))
  } catch (error) {
    return payloadError(error, request)
  }
}
