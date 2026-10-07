import { getPayload } from 'payload'

import config from '@payload-config'
import { resolve } from '@/server/incidents/actions'
import { auditIncidentAction } from '@/server/incidents/audit'
import { actionSource, readNote } from '@/server/incidents/http'
import { loadOrgIncident } from '@/server/incidents/store'
import {
  authenticate,
  authorize,
  jsonError,
  parseId,
  payloadError,
  readJson,
} from '@/server/monitors/http'
import { errorText } from '@/server/request-locale'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ orgId: string; id: string }> }

/**
 * POST /api/orgs/:orgId/monitor-incidents/:id/resolve — resolve an incident by hand (the engine resolves it on recovery anyway); the channels are told (`resolved`). 409 when it is already resolved.
 * Body (optional): `{ note }`. Answers the updated incident.
 */
export async function POST(request: Request, { params }: RouteContext) {
  const payload = await getPayload({ config })
  const { orgId: rawOrgId, id: rawId } = await params
  const orgId = parseId(payload, rawOrgId)

  const auth = await authenticate(payload, request)
  if (auth.response) return auth.response
  const forbidden = await authorize(payload, auth.user, orgId, 'monitor-incident:resolve')
  if (forbidden) return forbidden

  const incident = await loadOrgIncident(payload, auth.user, orgId, parseId(payload, rawId))
  if (!incident) return jsonError(404, errorText(request, 'incidentNotFound'))

  try {
    const via = actionSource(request)
    const summary = await resolve(payload, incident, {
      userId: auth.user.id,
      via,
      note: readNote(await readJson(request)),
    })
    await auditIncidentAction(payload, request, summary, 'monitor_incident.resolved', auth.user, {
      via,
    })
    return Response.json(summary)
  } catch (error) {
    return payloadError(error, request)
  }
}
