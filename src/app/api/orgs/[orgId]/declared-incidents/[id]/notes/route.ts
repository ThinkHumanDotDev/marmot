import { getPayload } from 'payload'

import config from '@payload-config'
import { declaredNoteSchema } from '@/lib/validation/declared-incident'
import type { DeclaredIncident } from '@/payload-types'
import type { DeclaredIncidentContext } from '@/server/declared-incidents/hooks'
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

/**
 * POST /api/orgs/:orgId/declared-incidents/:id/notes — append a note to the timeline.
 * Body: `{ message }`. Answers 201 with the incident; 409 once it is closed or canceled.
 */
export async function POST(request: Request, { params }: RouteContext) {
  const payload = await getPayload({ config })
  const { orgId: rawOrgId, id } = await params
  const orgId = parseId(payload, rawOrgId)
  const auth = await authenticate(payload, request)
  if (auth.response) return auth.response
  const forbidden = await authorize(payload, auth.user, orgId, 'declared-incident:update')
  if (forbidden) return forbidden

  const parsed = declaredNoteSchema.safeParse(await readJson(request))
  if (!parsed.success) return validationError(parsed.error, request)
  const existing = await loadOrgDeclaredIncident(payload, auth.user, orgId, parseId(payload, id))
  if (!existing) return jsonError(404, errorText(request, 'declaredIncidentNotFound'))
  try {
    const context: DeclaredIncidentContext = { declaredIncidentNote: parsed.data.message }
    const doc = (await payload.update({
      collection: 'declared-incidents',
      id: existing.id,
      data: {},
      context: context as Record<string, unknown>,
      depth: 0,
      user: auth.user,
      overrideAccess: false,
    })) as DeclaredIncident
    return Response.json(await serializeDeclaredIncident(payload, doc), { status: 201 })
  } catch (error) {
    return payloadError(error, request)
  }
}
