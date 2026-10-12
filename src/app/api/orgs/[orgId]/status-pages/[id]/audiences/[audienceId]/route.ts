import { audienceData, loadOrgAudience } from '@/server/status-pages/audiences-http'
import { authenticate, errorResponse, jsonError, readJson } from '@/server/status-pages/http'
import { errorText } from '@/server/request-locale'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ orgId: string; id: string; audienceId: string }> }

/**
 * PATCH /api/orgs/:orgId/status-pages/:id/audiences/:audienceId
 * `{ name?, components?, emails?, emailDomains? }` — edits an audience (#151); signed-in viewers
 * see the change on their next request. `status-page:update`.
 */
export async function PATCH(request: Request, { params }: RouteContext) {
  const auth = await authenticate(request)
  if (!auth.ok) return auth.response
  const { payload, user } = auth.ctx
  const { orgId, id, audienceId } = await params

  const body = await readJson(request)
  if (!body) return jsonError(errorText(request, 'invalidJsonBody'), 400)

  try {
    const found = await loadOrgAudience(auth.ctx, orgId, id, audienceId)
    if (!found) return jsonError(errorText(request, 'statusPageAudienceNotFound'), 404)

    const doc = await payload.update({
      collection: 'status-page-audiences',
      id: found.audience.id,
      data: audienceData(body),
      depth: 0,
      user,
      overrideAccess: false,
    })
    return Response.json({ doc })
  } catch (error) {
    return errorResponse(error, request)
  }
}

/**
 * DELETE /api/orgs/:orgId/status-pages/:id/audiences/:audienceId — removes an audience; its members
 * lose access unless another audience lists them. `status-page:update`.
 */
export async function DELETE(request: Request, { params }: RouteContext) {
  const auth = await authenticate(request)
  if (!auth.ok) return auth.response
  const { payload, user } = auth.ctx
  const { orgId, id, audienceId } = await params

  try {
    const found = await loadOrgAudience(auth.ctx, orgId, id, audienceId)
    if (!found) return jsonError(errorText(request, 'statusPageAudienceNotFound'), 404)

    await payload.delete({
      collection: 'status-page-audiences',
      id: found.audience.id,
      user,
      overrideAccess: false,
    })
    return Response.json({ ok: true })
  } catch (error) {
    return errorResponse(error, request)
  }
}
