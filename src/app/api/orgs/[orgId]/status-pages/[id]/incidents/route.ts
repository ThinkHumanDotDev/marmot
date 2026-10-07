import {
  authenticate,
  errorResponse,
  INCIDENT_WRITABLE_FIELDS,
  jsonError,
  loadOrgStatusPage,
  pick,
  readJson,
} from '@/server/status-pages/http'

import type { Incident } from '@/payload-types'
import { errorText } from '@/server/request-locale'

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
    if (!page) return jsonError(errorText(request, 'statusPageNotFound'), 404)

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
    return errorResponse(error, request)
  }
}

/** POST /api/orgs/:orgId/status-pages/:id/incidents — create an incident on the page. */
export async function POST(request: Request, { params }: RouteContext) {
  const auth = await authenticate(request)
  if (!auth.ok) return auth.response
  const { payload, user } = auth.ctx
  const { orgId, id } = await params

  const body = await readJson(request)
  if (!body) return jsonError(errorText(request, 'invalidJsonBody'), 400)

  try {
    const page = await loadOrgStatusPage(auth.ctx, orgId, id, 0)
    if (!page) return jsonError(errorText(request, 'statusPageNotFound'), 404)

    const doc = await payload.create({
      collection: 'incidents',
      data: {
        ...pick<Partial<Incident>>(body, INCIDENT_WRITABLE_FIELDS),
        title: String(body.title ?? ''),
        style: (body.style as Incident['style']) ?? 'info',
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
    return errorResponse(error, request)
  }
}
