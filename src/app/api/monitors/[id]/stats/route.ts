import { getPayload } from 'payload'

import config from '@payload-config'
import { isPercentile, PERCENTILES, type Percentile } from '@/server/stats/latency-histogram'
import { getRangeStats } from '@/server/stats/range-stats'
import { isStatsRange, STATS_RANGES } from '@/server/stats/uptime-calculator'
import { errorText, rememberRequestUser } from '@/server/request-locale'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ id: string }> }

/**
 * GET /api/monitors/:id/stats?range=1d|7d|14d|30d|90d|24h|1y&percentile=p50,p95
 *
 * Returns `{ uptime, avgPing, degraded, buckets, range, granularity }` for a monitor, plus (#95)
 * `percentiles` (p50 … p99 over the window), `checks` (total / up / failed / degraded /
 * maintenance), `step` and `series` (one point per `step` seconds with counts, average ping and
 * the requested percentiles; all five when `percentile` is omitted). The rollup is picked from the
 * range, so no raw heartbeats are read. Requires an
 * authenticated Payload session (cookie or `Authorization: JWT …`). The monitor is loaded with
 * the caller's access control, so organization scoping applies as soon as the `monitors`
 * collection enforces it.
 */
export async function GET(request: Request, { params }: RouteContext) {
  const { id } = await params
  const searchParams = new URL(request.url).searchParams
  const range = searchParams.get('range') ?? '24h'
  const percentileParam = searchParams.get('percentile')

  if (!isStatsRange(range)) {
    return Response.json(
      { error: errorText(request, 'statsRangeInvalid', { ranges: STATS_RANGES.join(', ') }) },
      { status: 400 },
    )
  }

  let percentiles: Percentile[] = [...PERCENTILES]
  if (percentileParam !== null && percentileParam.trim() !== '') {
    const requested = percentileParam.split(',').map((value) => value.trim())
    if (!requested.every(isPercentile)) {
      return Response.json(
        {
          error: errorText(request, 'statsPercentileInvalid', {
            percentiles: PERCENTILES.join(', '),
          }),
        },
        { status: 400 },
      )
    }
    percentiles = PERCENTILES.filter((key) => requested.includes(key))
  }

  const payload = await getPayload({ config })
  const { user } = await payload.auth({ headers: request.headers })
  rememberRequestUser(request, user)
  if (!user) {
    return Response.json({ error: errorText(request, 'unauthenticated') }, { status: 401 })
  }

  // Postgres/SQLite use numeric ids, MongoDB uses strings.
  const monitorId = payload.db.defaultIDType === 'number' && /^\d+$/.test(id) ? Number(id) : id

  try {
    await payload.findByID({
      collection: 'monitors',
      id: monitorId,
      user,
      overrideAccess: false,
      depth: 0,
    })
  } catch {
    return Response.json({ error: errorText(request, 'monitorNotFound') }, { status: 404 })
  }

  const stats = await getRangeStats(payload, monitorId, range, { percentiles })
  return Response.json(stats)
}
