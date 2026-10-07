import { getPayload } from 'payload'

import config from '@payload-config'
import { getStats, isStatsRange, STATS_RANGES } from '@/server/stats/uptime-calculator'
import { errorText, rememberRequestUser } from '@/server/request-locale'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ id: string }> }

/**
 * GET /api/monitors/:id/stats?range=24h|30d|1y
 *
 * Returns `{ uptime, avgPing, buckets, range, granularity }` for a monitor. Requires an
 * authenticated Payload session (cookie or `Authorization: JWT …`). The monitor is loaded with
 * the caller's access control, so organization scoping applies as soon as the `monitors`
 * collection enforces it.
 */
export async function GET(request: Request, { params }: RouteContext) {
  const { id } = await params
  const range = new URL(request.url).searchParams.get('range') ?? '24h'

  if (!isStatsRange(range)) {
    return Response.json(
      { error: errorText(request, 'statsRangeInvalid', { ranges: STATS_RANGES.join(', ') }) },
      { status: 400 },
    )
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

  const stats = await getStats(payload, monitorId, range)
  return Response.json(stats)
}
