import {
  authenticate,
  coerceId,
  errorResponse,
  jsonError,
  pick,
  readJson,
  STATUS_PAGE_WRITABLE_FIELDS,
} from '@/server/status-pages/http'

import type { StatusPage } from '@/payload-types'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ orgId: string }> }

/** GET /api/orgs/:orgId/status-pages — the organization's status pages (drafts included). */
export async function GET(request: Request, { params }: RouteContext) {
  const auth = await authenticate(request)
  if (!auth.ok) return auth.response
  const { payload, user } = auth.ctx
  const { orgId } = await params

  try {
    const result = await payload.find({
      collection: 'status-pages',
      where: { organization: { equals: coerceId(payload, orgId) } },
      sort: 'title',
      limit: 200,
      depth: 1,
      user,
      overrideAccess: false,
    })
    return Response.json(result)
  } catch (error) {
    return errorResponse(error)
  }
}

/** POST /api/orgs/:orgId/status-pages — create a status page in the organization. */
export async function POST(request: Request, { params }: RouteContext) {
  const auth = await authenticate(request)
  if (!auth.ok) return auth.response
  const { payload, user } = auth.ctx
  const { orgId } = await params

  const body = await readJson(request)
  if (!body) return jsonError('Invalid JSON body', 400)

  try {
    const doc = await payload.create({
      collection: 'status-pages',
      data: {
        ...pick<Partial<StatusPage>>(body, STATUS_PAGE_WRITABLE_FIELDS),
        title: String(body.title ?? ''),
        slug: String(body.slug ?? ''),
        organization: coerceId(payload, orgId) as StatusPage['organization'],
      },
      depth: 1,
      user,
      overrideAccess: false,
    })
    return Response.json({ doc }, { status: 201 })
  } catch (error) {
    return errorResponse(error)
  }
}
