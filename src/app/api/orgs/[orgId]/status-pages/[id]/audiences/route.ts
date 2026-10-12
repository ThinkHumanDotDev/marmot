import {
  authenticate,
  errorResponse,
  jsonError,
  loadOrgStatusPage,
  readJson,
} from '@/server/status-pages/http'
import { errorText } from '@/server/request-locale'

import { audienceData } from '@/server/status-pages/audiences-http'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ orgId: string; id: string }> }

/**
 * GET /api/orgs/:orgId/status-pages/:id/audiences — the page's audiences (#151), oldest first.
 * Members with `status-page:read`.
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
      collection: 'status-page-audiences',
      where: { statusPage: { equals: page.id } },
      sort: 'createdAt',
      limit: 0,
      pagination: false,
      depth: 0,
      user,
      overrideAccess: false,
    })
    return Response.json({ docs: result.docs })
  } catch (error) {
    return errorResponse(error, request)
  }
}

/**
 * POST /api/orgs/:orgId/status-pages/:id/audiences `{ name, components?, emails?, emailDomains? }`
 * — creates an audience. `status-page:update`.
 */
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
      collection: 'status-page-audiences',
      data: {
        ...audienceData(body),
        name: typeof body.name === 'string' ? body.name : '',
        statusPage: page.id,
        organization: page.organization,
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
