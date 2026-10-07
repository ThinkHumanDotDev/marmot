import {
  authenticate,
  errorResponse,
  jsonError,
  pick,
  readJson,
  STATUS_PAGE_WRITABLE_FIELDS,
  loadOrgStatusPage,
} from '@/server/status-pages/http'

import type { StatusPage } from '@/payload-types'
import { errorText } from '@/server/request-locale'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ orgId: string; id: string }> }

/** GET /api/orgs/:orgId/status-pages/:id */
export async function GET(request: Request, { params }: RouteContext) {
  const auth = await authenticate(request)
  if (!auth.ok) return auth.response
  const { orgId, id } = await params

  try {
    const doc = await loadOrgStatusPage(auth.ctx, orgId, id)
    if (!doc) return jsonError(errorText(request, 'statusPageNotFound'), 404)
    return Response.json({ doc })
  } catch (error) {
    return errorResponse(error, request)
  }
}

/** PATCH /api/orgs/:orgId/status-pages/:id — partial update of the writable fields. */
export async function PATCH(request: Request, { params }: RouteContext) {
  const auth = await authenticate(request)
  if (!auth.ok) return auth.response
  const { payload, user } = auth.ctx
  const { orgId, id } = await params

  const body = await readJson(request)
  if (!body) return jsonError(errorText(request, 'invalidJsonBody'), 400)

  try {
    const existing = await loadOrgStatusPage(auth.ctx, orgId, id, 0)
    if (!existing) return jsonError(errorText(request, 'statusPageNotFound'), 404)

    const doc = await payload.update({
      collection: 'status-pages',
      id: existing.id,
      data: pick<Partial<StatusPage>>(body, STATUS_PAGE_WRITABLE_FIELDS),
      depth: 1,
      user,
      overrideAccess: false,
    })
    return Response.json({ doc })
  } catch (error) {
    return errorResponse(error, request)
  }
}

/** DELETE /api/orgs/:orgId/status-pages/:id — deletes the page and its incidents. */
export async function DELETE(request: Request, { params }: RouteContext) {
  const auth = await authenticate(request)
  if (!auth.ok) return auth.response
  const { payload, user } = auth.ctx
  const { orgId, id } = await params

  try {
    const existing = await loadOrgStatusPage(auth.ctx, orgId, id, 0)
    if (!existing) return jsonError(errorText(request, 'statusPageNotFound'), 404)

    await payload.delete({
      collection: 'incidents',
      where: { statusPage: { equals: existing.id } },
      user,
      overrideAccess: false,
    })
    await payload.delete({
      collection: 'status-pages',
      id: existing.id,
      user,
      overrideAccess: false,
    })
    return Response.json({ ok: true })
  } catch (error) {
    return errorResponse(error, request)
  }
}
