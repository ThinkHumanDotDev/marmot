import type { StatusPageSubscriber } from '@/payload-types'
import { findPageAudiences } from '@/server/status-pages/audiences'
import { errorResponse } from '@/server/status-pages/http'
import { ownerContext, subscribersToCsv } from '@/server/status-pages/subscribers/owner'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ orgId: string; id: string }> }

/**
 * GET /api/orgs/:orgId/status-pages/:id/subscribers/export — every subscriber of the page as CSV
 * (`channel,target,components,source,confirmed_at,audiences`; audiences by name, #278). Needs
 * `subscriber:read`. Webhook secrets and headers are not exported.
 */
export async function GET(request: Request, { params }: RouteContext) {
  const { orgId, id } = await params
  const owner = await ownerContext(request, orgId, id, 'subscriber:read')
  if (!owner.ok) return owner.response
  try {
    const { docs } = await owner.ctx.payload.find({
      collection: 'status-page-subscribers',
      where: { statusPage: { equals: owner.ctx.page.id } },
      sort: 'createdAt',
      depth: 0,
      limit: 0,
      pagination: false,
      user: owner.ctx.user,
      overrideAccess: false,
    })
    const audiences = await findPageAudiences(owner.ctx.payload, owner.ctx.page.id)
    const names = new Map(audiences.map((a) => [String(a.id), a.name]))
    const filename = `${owner.ctx.page.slug}-subscribers.csv`
    return new Response(subscribersToCsv(docs as StatusPageSubscriber[], names), {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'private, no-store',
      },
    })
  } catch (error) {
    return errorResponse(error, request)
  }
}
