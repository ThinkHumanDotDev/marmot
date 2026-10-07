import type { SubscriberNotification } from '@/payload-types'
import { errorResponse } from '@/server/status-pages/http'
import { ownerContext, ownerNotification } from '@/server/status-pages/subscribers/owner'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ orgId: string; id: string }> }

/**
 * GET /api/orgs/:orgId/status-pages/:id/notifications — the page's subscriber notifications, newest
 * first (drafts awaiting review included). Needs `subscriber:read`.
 */
export async function GET(request: Request, { params }: RouteContext) {
  const { orgId, id } = await params
  const owner = await ownerContext(request, orgId, id, 'subscriber:read')
  if (!owner.ok) return owner.response
  try {
    const result = await owner.ctx.payload.find({
      collection: 'subscriber-notifications',
      where: { statusPage: { equals: owner.ctx.page.id } },
      sort: '-createdAt',
      limit: 100,
      depth: 0,
      user: owner.ctx.user,
      overrideAccess: false,
    })
    return Response.json({
      docs: (result.docs as SubscriberNotification[]).map(ownerNotification),
    })
  } catch (error) {
    return errorResponse(error, request)
  }
}
