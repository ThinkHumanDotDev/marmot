import type { Notification } from '@/payload-types'
import {
  errorMessage,
  errorStatus,
  jsonError,
  pickInput,
  readJson,
  resolveOrgRequest,
  toClientNotification,
} from '@/server/notifications/api'
import { errorText } from '@/server/request-locale'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ orgId: string }> }

/** GET /api/orgs/:orgId/notifications — channels of the organization (`notification:read`). */
export async function GET(request: Request, { params }: RouteContext) {
  const { orgId } = await params
  const ctx = await resolveOrgRequest(request, orgId, 'notification:read')
  if (ctx instanceof Response) return ctx

  const { docs } = await ctx.payload.find({
    collection: 'notifications',
    where: { organization: { equals: ctx.orgId } },
    sort: 'name',
    depth: 0,
    limit: 200,
    user: ctx.user,
    overrideAccess: false,
  })
  return Response.json({
    docs: docs.map((doc) => toClientNotification(doc as Notification, ctx.user, ctx.orgId)),
  })
}

/** POST /api/orgs/:orgId/notifications — create a channel (`notification:create`). */
export async function POST(request: Request, { params }: RouteContext) {
  const { orgId } = await params
  const ctx = await resolveOrgRequest(request, orgId, 'notification:create')
  if (ctx instanceof Response) return ctx

  const body = await readJson(request)
  if (!body) return jsonError(400, errorText(request, 'invalidJsonBody'))
  const input = pickInput(body)
  if (!input.name) return jsonError(400, errorText(request, 'nameRequired'))
  if (!input.type) return jsonError(400, errorText(request, 'typeRequired'))

  try {
    const doc = await ctx.payload.create({
      collection: 'notifications',
      data: {
        name: input.name,
        type: input.type,
        config: input.config ?? {},
        ...(input.events ? { events: input.events } : {}),
        isDefault: input.isDefault ?? false,
        applyExisting: input.applyExisting ?? false,
        active: input.active ?? true,
        organization: ctx.orgId as Notification['organization'],
      },
      depth: 0,
      user: ctx.user,
      overrideAccess: false,
    })
    return Response.json({ doc }, { status: 201 })
  } catch (error) {
    return jsonError(errorStatus(error), errorMessage(error, request))
  }
}
