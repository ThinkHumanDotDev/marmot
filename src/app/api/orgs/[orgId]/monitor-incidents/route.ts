import { getPayload } from 'payload'

import config from '@payload-config'
import { isIncidentRange, isIncidentStatusFilter } from '@/lib/monitor-incidents'
import { listOrgIncidents } from '@/server/incidents/store'
import { authenticate, authorize, parseId, payloadError } from '@/server/monitors/http'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ orgId: string }> }

/**
 * GET /api/orgs/:orgId/monitor-incidents — incidents of the organization, newest first.
 *
 * Query: `status` (`active` | `all` | `open` | `acknowledged` | `resolved`, default `all`),
 * `monitor` (id), `range` (`24h` | `7d` | `30d` | `90d` | `all`, by start time, default `30d`),
 * `page`, `limit` (≤ 100). Answers `{ docs, page, totalPages, totalDocs, stats }` where `stats`
 * holds the counts and MTTA/MTTR (seconds) of the monitor and range filters.
 */
export async function GET(request: Request, { params }: RouteContext) {
  const payload = await getPayload({ config })
  const orgId = parseId(payload, (await params).orgId)

  const auth = await authenticate(payload, request)
  if (auth.response) return auth.response
  const forbidden = await authorize(payload, auth.user, orgId, 'monitor-incident:read')
  if (forbidden) return forbidden

  const query = new URL(request.url).searchParams
  const status = query.get('status')
  const range = query.get('range')
  const monitor = query.get('monitor')
  try {
    const result = await listOrgIncidents(payload, orgId, {
      status: isIncidentStatusFilter(status) ? status : 'all',
      range: isIncidentRange(range) ? range : '30d',
      monitor: monitor ? parseId(payload, monitor) : null,
      page: Number.parseInt(query.get('page') ?? '1', 10) || 1,
      limit: Number.parseInt(query.get('limit') ?? '25', 10) || 25,
      user: auth.user,
    })
    return Response.json(result)
  } catch (error) {
    return payloadError(error, request)
  }
}
