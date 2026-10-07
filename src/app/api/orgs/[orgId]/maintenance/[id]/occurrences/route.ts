import { getPayload } from 'payload'

import config from '@payload-config'
import { listMaintenanceOccurrences, loadOrgMaintenance } from '@/server/maintenance'
import { authenticate, authorize, jsonError, parseId } from '@/server/monitors/http'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ orgId: string; id: string }> }

/**
 * GET /api/orgs/:orgId/maintenance/:id/occurrences — the maintenance's occurrences (upcoming and
 * recent, newest start first, at most `?limit=` (default 20, max 100)) with their timelines.
 */
export async function GET(request: Request, { params }: RouteContext): Promise<Response> {
  const payload = await getPayload({ config })
  const { orgId: rawOrgId, id: rawId } = await params
  const orgId = parseId(payload, rawOrgId)
  const id = parseId(payload, rawId)

  const auth = await authenticate(payload, request)
  if (auth.response) return auth.response
  const forbidden = await authorize(payload, auth.user, orgId, 'maintenance:read')
  if (forbidden) return forbidden

  const doc = await loadOrgMaintenance(payload, auth.user, orgId, id)
  if (!doc) return jsonError(404, 'Maintenance not found')

  const requested = Number(new URL(request.url).searchParams.get('limit') ?? 20)
  const limit = Number.isFinite(requested) ? Math.min(100, Math.max(1, Math.floor(requested))) : 20
  const docs = await listMaintenanceOccurrences(payload, doc.id, { limit, user: auth.user })
  return Response.json({ docs })
}
