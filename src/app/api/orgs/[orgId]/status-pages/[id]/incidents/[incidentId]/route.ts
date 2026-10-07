import {
  authenticate,
  errorResponse,
  INCIDENT_WRITABLE_FIELDS,
  jsonError,
  pick,
  readJson,
} from '@/server/status-pages/http'
import { loadOrgIncident as loadIncident } from '@/server/status-pages/incident-updates'

import type { Incident } from '@/payload-types'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ orgId: string; id: string; incidentId: string }> }

/** GET /api/orgs/:orgId/status-pages/:id/incidents/:incidentId — one incident with its timeline. */
export async function GET(request: Request, { params }: RouteContext) {
  const auth = await authenticate(request)
  if (!auth.ok) return auth.response
  const { orgId, id, incidentId } = await params

  try {
    const doc = await loadIncident(auth.ctx, orgId, id, incidentId)
    if (!doc) return jsonError('Incident not found', 404)
    return Response.json({ doc })
  } catch (error) {
    return errorResponse(error)
  }
}

/** PATCH /api/orgs/:orgId/status-pages/:id/incidents/:incidentId — rename, pin, set the declared
 * impact, or resolve/reopen via `active` (which posts a timeline update). */
export async function PATCH(request: Request, { params }: RouteContext) {
  const auth = await authenticate(request)
  if (!auth.ok) return auth.response
  const { payload, user } = auth.ctx
  const { orgId, id, incidentId } = await params

  const body = await readJson(request)
  if (!body) return jsonError('Invalid JSON body', 400)

  try {
    const incident = await loadIncident(auth.ctx, orgId, id, incidentId)
    if (!incident) return jsonError('Incident not found', 404)

    const doc = await payload.update({
      collection: 'incidents',
      id: incident.id,
      data: pick<Partial<Incident>>(body, INCIDENT_WRITABLE_FIELDS),
      depth: 0,
      user,
      overrideAccess: false,
    })
    return Response.json({ doc })
  } catch (error) {
    return errorResponse(error)
  }
}

/** DELETE /api/orgs/:orgId/status-pages/:id/incidents/:incidentId */
export async function DELETE(request: Request, { params }: RouteContext) {
  const auth = await authenticate(request)
  if (!auth.ok) return auth.response
  const { payload, user } = auth.ctx
  const { orgId, id, incidentId } = await params

  try {
    const incident = await loadIncident(auth.ctx, orgId, id, incidentId)
    if (!incident) return jsonError('Incident not found', 404)

    await payload.delete({ collection: 'incidents', id: incident.id, user, overrideAccess: false })
    return Response.json({ ok: true })
  } catch (error) {
    return errorResponse(error)
  }
}
