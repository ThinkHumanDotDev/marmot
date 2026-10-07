import { getPayload } from 'payload'

import config from '@payload-config'
import { canInOrg } from '@/access/overrides'
import { acknowledge } from '@/server/incidents/actions'
import { verifyAckToken } from '@/server/incidents/ack-link'
import { auditIncidentAction } from '@/server/incidents/audit'
import { getIncident, relId } from '@/server/incidents/store'
import { jsonError, parseId, payloadError, readJson } from '@/server/monitors/http'
import { errorText, rememberRequestUser } from '@/server/request-locale'
import type { RequestUser } from '@/server/monitors/http'

export const dynamic = 'force-dynamic'

/**
 * POST /api/incident-ack — acknowledge through the signed link of a notification
 * (`src/server/incidents/ack-link.ts`). Body: `{ token }`. No session needed; a signed-in member
 * with `monitor-incident:acknowledge` is recorded by name, anyone else as "via link". Answers
 * `{ status }`; 404 for an invalid or expired token, 409 when the incident is no longer open.
 */
export async function POST(request: Request) {
  const payload = await getPayload({ config })
  const body = (await readJson(request)) as { token?: unknown } | undefined
  const verified = verifyAckToken(typeof body?.token === 'string' ? body.token : null)
  if (!verified) return jsonError(404, errorText(request, 'incidentAckLinkInvalid'))

  const incident = await getIncident(payload, parseId(payload, verified.incidentId))
  if (!incident) return jsonError(404, errorText(request, 'incidentAckLinkInvalid'))

  const { user } = await payload.auth({ headers: request.headers }).catch(() => ({ user: null }))
  rememberRequestUser(request, user as RequestUser | null)
  const orgId = relId(incident.organization)
  const member =
    user && orgId !== null
      ? await canInOrg(payload, user as RequestUser, orgId, 'monitor-incident:acknowledge')
      : false

  try {
    const summary = await acknowledge(payload, incident, {
      userId: member && user ? user.id : null,
      via: 'link',
    })
    await auditIncidentAction(
      payload,
      request,
      summary,
      'monitor_incident.acknowledged',
      member && user ? (user as RequestUser) : null,
      { via: 'link' },
    )
    return Response.json({ status: summary.status })
  } catch (error) {
    return payloadError(error, request)
  }
}
