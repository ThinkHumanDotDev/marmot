import {
  authenticate,
  errorResponse,
  jsonError,
  loadOrgStatusPage,
} from '@/server/status-pages/http'
import { errorText } from '@/server/request-locale'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ orgId: string; id: string }> }

/**
 * GET /api/orgs/:orgId/status-pages/:id/viewers — visitors who signed in to the page with an email
 * link (`email-domain` access), most recently seen first.
 */
export async function GET(request: Request, { params }: RouteContext) {
  const auth = await authenticate(request)
  if (!auth.ok) return auth.response
  const { payload, user } = auth.ctx
  const { orgId, id } = await params

  try {
    const page = await loadOrgStatusPage(auth.ctx, orgId, id, 0)
    if (!page) return jsonError(errorText(request, 'statusPageNotFound'), 404)

    const result = await payload.find({
      collection: 'status-page-viewers',
      where: { page: { equals: page.id } },
      sort: '-lastSeenAt',
      limit: 500,
      depth: 0,
      user,
      overrideAccess: false,
    })
    return Response.json(result)
  } catch (error) {
    return errorResponse(error, request)
  }
}
