import { authenticate, errorResponse, jsonError, readJson } from '@/server/status-pages/http'
import {
  loadOrgIncident,
  parseUpdateInput,
  postIncidentUpdate,
} from '@/server/status-pages/incident-updates'
import { incidentTimeline } from '@/lib/incident-timeline'

import { errorText } from '@/server/request-locale'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ orgId: string; id: string; incidentId: string }> }

/** GET /api/orgs/:orgId/status-pages/:id/incidents/:incidentId/updates — timeline, oldest first. */
export async function GET(request: Request, { params }: RouteContext) {
  const auth = await authenticate(request)
  if (!auth.ok) return auth.response
  const { orgId, id, incidentId } = await params

  try {
    const incident = await loadOrgIncident(auth.ctx, orgId, id, incidentId)
    if (!incident) return jsonError(errorText(request, 'incidentNotFound'), 404)
    const { updates, state } = incidentTimeline(incident)
    return Response.json({ docs: updates, state })
  } catch (error) {
    return errorResponse(error, request)
  }
}

/**
 * POST /api/orgs/:orgId/status-pages/:id/incidents/:incidentId/updates — post an update.
 *
 * Body: `{ status, message?, components?: [{ monitor, impact }], postedAt?, impact? }`. Components
 * left out keep their last impact; `resolved` resets them all to operational.
 */
export async function POST(request: Request, { params }: RouteContext) {
  const auth = await authenticate(request)
  if (!auth.ok) return auth.response
  const { orgId, id, incidentId } = await params

  const body = await readJson(request)
  if (!body) return jsonError(errorText(request, 'invalidJsonBody'), 400)
  const parsed = parseUpdateInput(body)
  if (!parsed.ok) return jsonError(errorText(request, parsed.error), 400)

  try {
    const incident = await loadOrgIncident(auth.ctx, orgId, id, incidentId)
    if (!incident) return jsonError(errorText(request, 'incidentNotFound'), 404)
    const result = await postIncidentUpdate(auth.ctx, incident, parsed.input)
    return Response.json(result, { status: 201 })
  } catch (error) {
    return errorResponse(error, request)
  }
}
