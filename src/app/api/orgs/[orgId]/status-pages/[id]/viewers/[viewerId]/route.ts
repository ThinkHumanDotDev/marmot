import { STATUS_PAGE_VIEWER_STATUSES } from '@/collections/StatusPageViewers'
import {
  authenticate,
  coerceId,
  errorResponse,
  jsonError,
  loadOrgStatusPage,
  readJson,
  type Authenticated,
} from '@/server/status-pages/http'
import { errorText } from '@/server/request-locale'

import type { StatusPageViewer } from '@/payload-types'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ orgId: string; id: string; viewerId: string }> }

async function loadViewer(
  ctx: Authenticated,
  orgId: string,
  pageId: string,
  viewerId: string,
): Promise<StatusPageViewer | null> {
  const page = await loadOrgStatusPage(ctx, orgId, pageId, 0)
  if (!page) return null
  const { docs } = await ctx.payload.find({
    collection: 'status-page-viewers',
    where: {
      and: [{ id: { equals: coerceId(ctx.payload, viewerId) } }, { page: { equals: page.id } }],
    },
    limit: 1,
    depth: 0,
    user: ctx.user,
    overrideAccess: false,
  })
  return docs[0] ?? null
}

/**
 * PATCH /api/orgs/:orgId/status-pages/:id/viewers/:viewerId `{ status: 'active' | 'revoked' }` —
 * revoke (signs the visitor out, refuses new links to the address) or restore a visitor.
 */
export async function PATCH(request: Request, { params }: RouteContext) {
  const auth = await authenticate(request)
  if (!auth.ok) return auth.response
  const { payload, user } = auth.ctx
  const { orgId, id, viewerId } = await params

  const body = await readJson(request)
  const status = body?.status
  if (!STATUS_PAGE_VIEWER_STATUSES.includes(status as StatusPageViewer['status'])) {
    return jsonError(errorText(request, 'statusPageViewerStatusInvalid'), 400)
  }

  try {
    const viewer = await loadViewer(auth.ctx, orgId, id, viewerId)
    if (!viewer) return jsonError(errorText(request, 'statusPageViewerNotFound'), 404)

    const doc = await payload.update({
      collection: 'status-page-viewers',
      id: viewer.id,
      data: { status: status as StatusPageViewer['status'] },
      depth: 0,
      user,
      overrideAccess: false,
    })
    return Response.json({ doc })
  } catch (error) {
    return errorResponse(error, request)
  }
}

/** DELETE /api/orgs/:orgId/status-pages/:id/viewers/:viewerId — forget a visitor (signs them out). */
export async function DELETE(request: Request, { params }: RouteContext) {
  const auth = await authenticate(request)
  if (!auth.ok) return auth.response
  const { payload, user } = auth.ctx
  const { orgId, id, viewerId } = await params

  try {
    const viewer = await loadViewer(auth.ctx, orgId, id, viewerId)
    if (!viewer) return jsonError(errorText(request, 'statusPageViewerNotFound'), 404)

    await payload.delete({
      collection: 'status-page-viewers',
      id: viewer.id,
      user,
      overrideAccess: false,
    })
    return Response.json({ ok: true })
  } catch (error) {
    return errorResponse(error, request)
  }
}
