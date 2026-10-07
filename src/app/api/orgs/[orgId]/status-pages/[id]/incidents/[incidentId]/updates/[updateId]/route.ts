import { authenticate, errorResponse, jsonError, readJson } from '@/server/status-pages/http'
import { editIncidentUpdate, loadOrgIncident } from '@/server/status-pages/incident-updates'

export const dynamic = 'force-dynamic'

type RouteContext = {
  params: Promise<{ orgId: string; id: string; incidentId: string; updateId: string }>
}

/**
 * PATCH /api/orgs/:orgId/status-pages/:id/incidents/:incidentId/updates/:updateId — edit the text
 * of a posted update (`{ message }`). Status, time and impacts are history and stay as posted; the
 * update is marked as edited.
 */
export async function PATCH(request: Request, { params }: RouteContext) {
  const auth = await authenticate(request)
  if (!auth.ok) return auth.response
  const { orgId, id, incidentId, updateId } = await params

  const body = await readJson(request)
  if (!body || typeof body.message !== 'string') {
    return jsonError('Body must be { message: string }', 400)
  }

  try {
    const incident = await loadOrgIncident(auth.ctx, orgId, id, incidentId)
    if (!incident) return jsonError('Incident not found', 404)
    const result = await editIncidentUpdate(auth.ctx, incident, updateId, body.message)
    if (!result) return jsonError('Update not found', 404)
    return Response.json(result)
  } catch (error) {
    return errorResponse(error)
  }
}
