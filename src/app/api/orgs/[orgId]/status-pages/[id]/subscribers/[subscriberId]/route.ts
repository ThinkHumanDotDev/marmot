import type { StatusPageSubscriber } from '@/payload-types'
import { errorResponse, jsonError, readJson } from '@/server/status-pages/http'
import { errorText } from '@/server/request-locale'
import {
  loadOwnerSubscriber,
  ownerContext,
  ownerSubscriber,
} from '@/server/status-pages/subscribers/owner'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ orgId: string; id: string; subscriberId: string }> }

/**
 * PATCH /api/orgs/:orgId/status-pages/:id/subscribers/:subscriberId — `{ components?, headers? }`.
 * Needs `subscriber:manage`.
 */
export async function PATCH(request: Request, { params }: RouteContext) {
  const { orgId, id, subscriberId } = await params
  const owner = await ownerContext(request, orgId, id, 'subscriber:manage')
  if (!owner.ok) return owner.response
  const body = await readJson(request)
  if (!body) return jsonError(errorText(request, 'invalidJsonBody'), 400)
  try {
    const subscriber = await loadOwnerSubscriber(owner.ctx, subscriberId)
    if (!subscriber) return jsonError(errorText(request, 'subscriberNotFound'), 404)
    const data: Partial<StatusPageSubscriber> = {}
    if (Array.isArray(body.components)) data.components = body.components.map(String)
    if (Array.isArray(body.headers)) {
      data.headers = (body.headers as { name?: unknown; value?: unknown }[]).map((h) => ({
        name: String(h?.name ?? ''),
        value: String(h?.value ?? ''),
      }))
    }
    const doc = (await owner.ctx.payload.update({
      collection: 'status-page-subscribers',
      id: subscriber.id,
      data,
      depth: 0,
      user: owner.ctx.user,
      overrideAccess: false,
    })) as StatusPageSubscriber
    return Response.json({ doc: ownerSubscriber(doc) })
  } catch (error) {
    return errorResponse(error, request)
  }
}

/** DELETE /api/orgs/:orgId/status-pages/:id/subscribers/:subscriberId. Needs `subscriber:manage`. */
export async function DELETE(request: Request, { params }: RouteContext) {
  const { orgId, id, subscriberId } = await params
  const owner = await ownerContext(request, orgId, id, 'subscriber:manage')
  if (!owner.ok) return owner.response
  try {
    const subscriber = await loadOwnerSubscriber(owner.ctx, subscriberId)
    if (!subscriber) return jsonError(errorText(request, 'subscriberNotFound'), 404)
    await owner.ctx.payload.delete({
      collection: 'status-page-subscribers',
      id: subscriber.id,
      user: owner.ctx.user,
      overrideAccess: false,
    })
    return Response.json({ ok: true })
  } catch (error) {
    return errorResponse(error, request)
  }
}
