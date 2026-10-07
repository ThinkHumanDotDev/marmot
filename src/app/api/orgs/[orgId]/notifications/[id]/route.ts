import type { Notification } from '@/payload-types'
import {
  errorMessage,
  errorStatus,
  jsonError,
  parseDocId,
  pickInput,
  readJson,
  resolveOrgRequest,
  type OrgRequestContext,
} from '@/server/notifications/api'
import { errorText } from '@/server/request-locale'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ orgId: string; id: string }> }

/** Load the channel with the caller's access and make sure it belongs to the URL's organization. */
async function loadChannel(ctx: OrgRequestContext, rawId: string): Promise<Notification | null> {
  try {
    const doc = (await ctx.payload.findByID({
      collection: 'notifications',
      id: parseDocId(ctx.payload, rawId),
      depth: 0,
      user: ctx.user,
      overrideAccess: false,
    })) as Notification
    const org = typeof doc.organization === 'object' ? doc.organization.id : doc.organization
    return String(org) === String(ctx.orgId) ? doc : null
  } catch {
    return null
  }
}

/** PATCH /api/orgs/:orgId/notifications/:id — update a channel (`notification:update`). */
export async function PATCH(request: Request, { params }: RouteContext) {
  const { orgId, id } = await params
  const ctx = await resolveOrgRequest(request, orgId, 'notification:update')
  if (ctx instanceof Response) return ctx

  const existing = await loadChannel(ctx, id)
  if (!existing) return jsonError(404, errorText(request, 'notificationChannelNotFound'))

  const body = await readJson(request)
  if (!body) return jsonError(400, errorText(request, 'invalidJsonBody'))
  const input = pickInput(body)
  if (input.name === '') return jsonError(400, errorText(request, 'nameRequired'))

  try {
    const doc = await ctx.payload.update({
      collection: 'notifications',
      id: existing.id,
      data: input,
      depth: 0,
      user: ctx.user,
      overrideAccess: false,
    })
    return Response.json({ doc })
  } catch (error) {
    return jsonError(errorStatus(error), errorMessage(error, request))
  }
}

/** DELETE /api/orgs/:orgId/notifications/:id — remove a channel (`notification:delete`). */
export async function DELETE(request: Request, { params }: RouteContext) {
  const { orgId, id } = await params
  const ctx = await resolveOrgRequest(request, orgId, 'notification:delete')
  if (ctx instanceof Response) return ctx

  const existing = await loadChannel(ctx, id)
  if (!existing) return jsonError(404, errorText(request, 'notificationChannelNotFound'))

  try {
    await ctx.payload.delete({
      collection: 'notifications',
      id: existing.id,
      depth: 0,
      user: ctx.user,
      overrideAccess: false,
    })
    return Response.json({ ok: true })
  } catch (error) {
    return jsonError(errorStatus(error), errorMessage(error, request))
  }
}
