import {
  authenticate,
  coerceId,
  errorResponse,
  INCIDENT_WRITABLE_FIELDS,
  jsonError,
  loadOrgStatusPage,
  pick,
  readJson,
  type Authenticated,
} from '@/server/status-pages/http'

import type { Incident } from '@/payload-types'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ orgId: string; id: string; incidentId: string }> }

async function loadIncident(
  ctx: Authenticated,
  orgId: string,
  pageId: string,
  incidentId: string,
): Promise<Incident | null> {
  const page = await loadOrgStatusPage(ctx, orgId, pageId, 0)
  if (!page) return null
  const { docs } = await ctx.payload.find({
    collection: 'incidents',
    where: {
      and: [
        { id: { equals: coerceId(ctx.payload, incidentId) } },
        { statusPage: { equals: page.id } },
      ],
    },
    limit: 1,
    depth: 0,
    user: ctx.user,
    overrideAccess: false,
  })
  return docs[0] ?? null
}

/** PATCH /api/orgs/:orgId/status-pages/:id/incidents/:incidentId — edit, pin or resolve. */
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
