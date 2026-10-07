import { getPayload } from 'payload'

import config from '@payload-config'
import { isComponentImpact, isIncidentStatus } from '@/lib/incident-timeline'
import { auditIncidentAction } from '@/server/incidents/audit'
import { publishToStatusPage } from '@/server/incidents/publish'
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

const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)

/**
 * POST /api/orgs/:orgId/monitor-incidents/:id/publish — create a public status-page incident from
 * this incident (needs `status-page:update`). Body: `{ statusPageId, title?, message?, status?,
 * impact? }` (`status` defaults to `investigating`, `impact` to `major_outage`). Answers
 * `{ incident, statusPageIncident }` (201); 409 when it was published already.
 */
export async function POST(request: Request, { params }: RouteContext) {
  const payload = await getPayload({ config })
  const { orgId: rawOrgId, id: rawId } = await params
  const orgId = parseId(payload, rawOrgId)

  const auth = await authenticate(payload, request)
  if (auth.response) return auth.response
  const forbidden =
    (await authorize(payload, auth.user, orgId, 'monitor-incident:read')) ??
    (await authorize(payload, auth.user, orgId, 'status-page:update'))
  if (forbidden) return forbidden

  const incident = await loadOrgIncident(payload, auth.user, orgId, parseId(payload, rawId))
  if (!incident) return jsonError(404, errorText(request, 'incidentNotFound'))

  const body = (await readJson(request)) as Record<string, unknown> | undefined
  const statusPageId = body?.statusPageId
  if (typeof statusPageId !== 'string' && typeof statusPageId !== 'number') {
    return jsonError(400, errorText(request, 'validationFailed'), {
      issues: [{ path: 'statusPageId', message: 'Required' }],
    })
  }
  if (body?.status !== undefined && !isIncidentStatus(body.status)) {
    return jsonError(400, errorText(request, 'incidentUpdateStatusInvalid'))
  }
  if (body?.impact !== undefined && !isComponentImpact(body.impact)) {
    return jsonError(400, errorText(request, 'incidentImpactInvalid'))
  }

  try {
    const result = await publishToStatusPage(payload, auth.user, incident, {
      statusPageId: parseId(payload, String(statusPageId)),
      title: text(body?.title),
      message: text(body?.message),
      status: isIncidentStatus(body?.status) ? body.status : undefined,
      impact: isComponentImpact(body?.impact) ? body.impact : undefined,
    })
    await auditIncidentAction(
      payload,
      request,
      result.incident,
      'monitor_incident.published',
      auth.user,
      {
        statusPageId: String(statusPageId),
        statusPageIncidentId: String(result.statusPageIncident.id),
      },
    )
    return Response.json(result, { status: 201 })
  } catch (error) {
    return payloadError(error, request)
  }
}
