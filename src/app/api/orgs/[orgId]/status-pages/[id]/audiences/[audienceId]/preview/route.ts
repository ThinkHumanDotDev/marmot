import { scopePageToComponents } from '@/server/status-pages/audiences'
import { loadOrgAudience } from '@/server/status-pages/audiences-http'
import { authenticate, errorResponse, jsonError } from '@/server/status-pages/http'
import { buildPublicStatusPageData } from '@/server/status-pages/public'
import { errorText } from '@/server/request-locale'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ orgId: string; id: string; audienceId: string }> }

/**
 * GET /api/orgs/:orgId/status-pages/:id/audiences/:audienceId/preview — "view as audience" (#151):
 * the public payload of the page (`GET /api/status-pages/:slug/public`) exactly as members of this
 * audience see it, drafts included. Members with `status-page:read`; never cached.
 */
export async function GET(request: Request, { params }: RouteContext) {
  const auth = await authenticate(request)
  if (!auth.ok) return auth.response
  const { payload } = auth.ctx
  const { orgId, id, audienceId } = await params

  try {
    const found = await loadOrgAudience(auth.ctx, orgId, id, audienceId, 1)
    if (!found) return jsonError(errorText(request, 'statusPageAudienceNotFound'), 404)

    const page = scopePageToComponents(
      { ...found.page, access: 'audience' as const },
      (found.audience.components ?? []).map(String),
    )
    const data = await buildPublicStatusPageData(payload, page)
    // The preview is a snapshot: the builder does not poll it.
    data.config.autoRefreshInterval = 0
    return Response.json(data, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch (error) {
    return errorResponse(error, request)
  }
}
