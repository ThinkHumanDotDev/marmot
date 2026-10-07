import { getPayload } from 'payload'

import config from '@payload-config'
import { actorFromRequest } from '@/server/audit/context'
import { actorFields, recordRequestAuditEvent } from '@/server/security/audit'
import { occurrenceUpdateSchema } from '@/lib/maintenance-announcements'
import { unfilledPlaceholders } from '@/lib/templates'
import type { MaintenanceOccurrence } from '@/payload-types'
import {
  loadOrgMaintenance,
  postOccurrenceUpdate,
  relationId,
  summarizeMaintenance,
} from '@/server/maintenance'
import {
  authenticate,
  authorize,
  jsonError,
  parseId,
  payloadError,
  readJson,
  validationError,
} from '@/server/monitors/http'
import { errorText } from '@/server/request-locale'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ orgId: string; id: string; occurrenceId: string }> }

/**
 * POST /api/orgs/:orgId/maintenance/:id/occurrences/:occurrenceId/updates — post an update
 * `{ status, message }` on an occurrence. The current status adds a note; another allowed status
 * starts, verifies, completes or cancels it (409 when the transition is not allowed). Answers
 * `{ occurrence, maintenance }` (201).
 */
export async function POST(request: Request, { params }: RouteContext): Promise<Response> {
  const payload = await getPayload({ config })
  const { orgId: rawOrgId, id: rawId, occurrenceId: rawOccurrenceId } = await params
  const orgId = parseId(payload, rawOrgId)
  const id = parseId(payload, rawId)
  const occurrenceId = parseId(payload, rawOccurrenceId)

  const auth = await authenticate(payload, request)
  if (auth.response) return auth.response
  const forbidden = await authorize(payload, auth.user, orgId, 'maintenance:update')
  if (forbidden) return forbidden

  const maintenance = await loadOrgMaintenance(payload, auth.user, orgId, id)
  if (!maintenance) return jsonError(404, errorText(request, 'maintenanceNotFound'))

  let occurrence: MaintenanceOccurrence | null = null
  try {
    occurrence = (await payload.findByID({
      collection: 'maintenance-occurrences',
      id: occurrenceId,
      depth: 0,
      user: auth.user,
      overrideAccess: false,
    })) as MaintenanceOccurrence
  } catch {
    occurrence = null
  }
  if (!occurrence || String(relationId(occurrence.maintenance)) !== String(maintenance.id)) {
    return jsonError(404, errorText(request, 'maintenanceOccurrenceNotFound'))
  }

  const parsed = occurrenceUpdateSchema.safeParse(await readJson(request))
  if (!parsed.success) return validationError(parsed.error, request)
  // Template placeholders (`{{ eta }}`) must be replaced before an update is published (#153).
  const unfilled = unfilledPlaceholders(parsed.data.message)
  if (unfilled) return jsonError(400, errorText(request, 'templatePlaceholdersUnfilled', unfilled))

  try {
    const result = await postOccurrenceUpdate(payload, maintenance, occurrence, parsed.data)
    await recordRequestAuditEvent(payload, request, {
      ...actorFields(actorFromRequest({ user: auth.user })),
      action: 'maintenance_occurrence.updated',
      organization: orgId,
      entityType: 'maintenance_occurrence',
      entityId: occurrence.id,
      entityLabel: maintenance.title,
      before: { state: occurrence.state },
      after: { state: result.occurrence.state },
      changedFields: occurrence.state === result.occurrence.state ? [] : ['state'],
      metadata: { maintenanceId: String(maintenance.id), message: parsed.data.message ?? null },
    })
    return Response.json(
      {
        occurrence: result.occurrence,
        maintenance: await summarizeMaintenance(payload, result.maintenance),
      },
      { status: 201 },
    )
  } catch (error) {
    // `OccurrenceTransitionError` is a localised 409 with `{ from, to }` as data.
    return payloadError(error, request)
  }
}
