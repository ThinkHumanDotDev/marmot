import { getPayload } from 'payload'

import config from '@payload-config'
import { loadOrgIncident, serializeIncident } from '@/server/incidents/store'
import { authenticate, authorize, jsonError, parseId } from '@/server/monitors/http'
import { errorText } from '@/server/request-locale'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ orgId: string; id: string }> }

/** GET /api/orgs/:orgId/monitor-incidents/:id — one incident with its timeline. */
export async function GET(request: Request, { params }: RouteContext) {
  const payload = await getPayload({ config })
  const { orgId: rawOrgId, id: rawId } = await params
  const orgId = parseId(payload, rawOrgId)

  const auth = await authenticate(payload, request)
  if (auth.response) return auth.response
  const forbidden = await authorize(payload, auth.user, orgId, 'monitor-incident:read')
  if (forbidden) return forbidden

  const incident = await loadOrgIncident(payload, auth.user, orgId, parseId(payload, rawId))
  if (!incident) return jsonError(404, errorText(request, 'incidentNotFound'))
  return Response.json(await serializeIncident(payload, incident))
}
