import { getPayload } from 'payload'

import config from '@payload-config'
import { updateDeclaredIncidentSchema } from '@/lib/validation/declared-incident'
import type { DeclaredIncident } from '@/payload-types'
import { updateData } from '@/server/declared-incidents/http'
import {
  loadOrgDeclaredIncident,
  serializeDeclaredIncident,
} from '@/server/declared-incidents/store'
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

type RouteContext = { params: Promise<{ orgId: string; id: string }> }

/** GET /api/orgs/:orgId/declared-incidents/:id — one incident with its timeline and postmortem. */
export async function GET(request: Request, { params }: RouteContext) {
  const payload = await getPayload({ config })
  const { orgId: rawOrgId, id } = await params
  const orgId = parseId(payload, rawOrgId)
  const auth = await authenticate(payload, request)
  if (auth.response) return auth.response
  const forbidden = await authorize(payload, auth.user, orgId, 'declared-incident:read')
  if (forbidden) return forbidden

  const doc = await loadOrgDeclaredIncident(payload, auth.user, orgId, parseId(payload, id))
  if (!doc) return jsonError(404, errorText(request, 'declaredIncidentNotFound'))
  return Response.json(await serializeDeclaredIncident(payload, doc))
}

/**
 * PATCH /api/orgs/:orgId/declared-incidents/:id — change the incident: `title`, `severity`,
 * `summary`, `commander`, `status` (allowed transitions only, 409 otherwise), `startedAt`,
 * `statusPageIncident` (link or `null` to unlink), `postmortem` (Markdown; saving makes it a draft),
 * `approvePostmortem: true`, and `skipPostmortem: true` with `status: 'closed'` (admins). Closed
 * and canceled incidents answer 409.
 */
export async function PATCH(request: Request, { params }: RouteContext) {
  const payload = await getPayload({ config })
  const { orgId: rawOrgId, id } = await params
  const orgId = parseId(payload, rawOrgId)
  const auth = await authenticate(payload, request)
  if (auth.response) return auth.response
  const forbidden = await authorize(payload, auth.user, orgId, 'declared-incident:update')
  if (forbidden) return forbidden

  const parsed = updateDeclaredIncidentSchema.safeParse(await readJson(request))
  if (!parsed.success) return validationError(parsed.error, request)
  const existing = await loadOrgDeclaredIncident(payload, auth.user, orgId, parseId(payload, id))
  if (!existing) return jsonError(404, errorText(request, 'declaredIncidentNotFound'))
  try {
    const doc = (await payload.update({
      collection: 'declared-incidents',
      id: existing.id,
      data: updateData(payload, parsed.data) as never,
      depth: 0,
      user: auth.user,
      overrideAccess: false,
    })) as DeclaredIncident
    return Response.json(await serializeDeclaredIncident(payload, doc))
  } catch (error) {
    return payloadError(error, request)
  }
}

/** DELETE /api/orgs/:orgId/declared-incidents/:id — remove a declared-by-mistake incident (admins). */
export async function DELETE(request: Request, { params }: RouteContext) {
  const payload = await getPayload({ config })
  const { orgId: rawOrgId, id } = await params
  const orgId = parseId(payload, rawOrgId)
  const auth = await authenticate(payload, request)
  if (auth.response) return auth.response
  const forbidden = await authorize(payload, auth.user, orgId, 'declared-incident:delete')
  if (forbidden) return forbidden

  const existing = await loadOrgDeclaredIncident(payload, auth.user, orgId, parseId(payload, id))
  if (!existing) return jsonError(404, errorText(request, 'declaredIncidentNotFound'))
  try {
    await payload.delete({
      collection: 'declared-incidents',
      id: existing.id,
      user: auth.user,
      overrideAccess: false,
    })
    return new Response(null, { status: 204 })
  } catch (error) {
    return payloadError(error, request)
  }
}
