import {
  authenticate,
  errorResponse,
  INCIDENT_CREATE_FIELDS,
  jsonError,
  loadOrgStatusPage,
  pick,
  readJson,
} from '@/server/status-pages/http'
import { parseUpdateInput, toUpdateRow } from '@/server/status-pages/incident-updates'

import type { Incident } from '@/payload-types'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ orgId: string; id: string }> }

/** GET /api/orgs/:orgId/status-pages/:id/incidents — all incidents of the page, newest first. */
export async function GET(request: Request, { params }: RouteContext) {
  const auth = await authenticate(request)
  if (!auth.ok) return auth.response
  const { payload, user } = auth.ctx
  const { orgId, id } = await params

  try {
    const page = await loadOrgStatusPage(auth.ctx, orgId, id, 0)
    if (!page) return jsonError('Status page not found', 404)

    const result = await payload.find({
      collection: 'incidents',
      where: { statusPage: { equals: page.id } },
      sort: '-createdAt',
      limit: 200,
      depth: 0,
      user,
      overrideAccess: false,
    })
    return Response.json(result)
  } catch (error) {
    return errorResponse(error)
  }
}

/**
 * POST /api/orgs/:orgId/status-pages/:id/incidents — open an incident on the page.
 *
 * Body: `{ title, pinned?, status?, message?, components?: [{ monitor, impact }], impact? }`; the
 * first update is built from `status` (default `investigating`), `message` and `components`.
 * Pre-timeline clients may still send `{ title, content, style }`.
 */
export async function POST(request: Request, { params }: RouteContext) {
  const auth = await authenticate(request)
  if (!auth.ok) return auth.response
  const { payload, user } = auth.ctx
  const { orgId, id } = await params

  const body = await readJson(request)
  if (!body) return jsonError('Invalid JSON body', 400)

  try {
    const page = await loadOrgStatusPage(auth.ctx, orgId, id, 0)
    if (!page) return jsonError('Status page not found', 404)

    const timeline = ['status', 'message', 'components'].some((key) => key in body)
    let updates: Incident['updates'] | undefined
    if (timeline) {
      const parsed = parseUpdateInput(body, { status: 'investigating' })
      if (!parsed.ok) return jsonError(parsed.error, 400)
      updates = [toUpdateRow(parsed.input)]
    }

    const doc = await payload.create({
      collection: 'incidents',
      data: {
        ...pick<Partial<Incident>>(body, INCIDENT_CREATE_FIELDS),
        ...(updates ? { updates } : {}),
        title: String(body.title ?? ''),
        statusPage: page.id,
        organization:
          typeof page.organization === 'object' ? page.organization.id : page.organization,
      },
      depth: 0,
      user,
      overrideAccess: false,
    })
    return Response.json({ doc }, { status: 201 })
  } catch (error) {
    return errorResponse(error)
  }
}
