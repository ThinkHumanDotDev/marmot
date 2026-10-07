import { getPayload } from 'payload'

import config from '@payload-config'
import { acknowledge } from '@/server/incidents/actions'
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
 * POST /api/orgs/:orgId/monitor-incidents/:id/acknowledge — acknowledge an open incident: reminders stop re-sending and the monitor's channels are told (`acknowledged`). 409 when it is already acknowledged or resolved.
 * Body (optional): `{ note }`. Answers the updated incident.
 */
export async function POST(request: Request, { params }: RouteContext) {
  const payload = await getPayload({ config })
  const { orgId: rawOrgId, id: rawId } = await params
  const orgId = parseId(payload, rawOrgId)

  const auth = await authenticate(payload, request)
  if (auth.response) return auth.response
  const forbidden = await authorize(payload, auth.user, orgId, 'monitor-incident:acknowledge')
  if (forbidden) return forbidden

  const incident = await loadOrgIncident(payload, auth.user, orgId, parseId(payload, rawId))
  if (!incident) return jsonError(404, errorText(request, 'incidentNotFound'))

  try {
    const summary = await acknowledge(payload, incident, {
      userId: auth.user.id,
      via: actionSource(request),
      note: readNote(await readJson(request)),
    })
    return Response.json(summary)
  } catch (error) {
    return payloadError(error, request)
  }
}
