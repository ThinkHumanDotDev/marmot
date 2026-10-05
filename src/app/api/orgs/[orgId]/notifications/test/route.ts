import type { Notification } from '@/payload-types'
import { jsonError, parseDocId, readJson, resolveOrgRequest } from '@/server/notifications/api'
import { sendTestNotification, type NotificationChannelLike } from '@/server/notifications/send'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ orgId: string }> }

type TestBody = {
  notificationId?: string | number
  type?: string
  config?: unknown
  name?: string
}

/**
 * POST /api/orgs/:orgId/notifications/test — send a test message (`notification:update`).
 *
 * Body: `{ notificationId }` for a saved channel, or `{ type, config, name? }` for an unsaved one.
 * Responds `{ ok: true, result }` or 400 `{ ok: false, error }` with the provider's message.
 */
export async function POST(request: Request, { params }: RouteContext) {
  const { orgId } = await params
  const ctx = await resolveOrgRequest(request, orgId, 'notification:update')
  if (ctx instanceof Response) return ctx

  const body = await readJson<TestBody>(request)
  if (!body) return jsonError(400, 'Invalid JSON body', { ok: false })

  let channel: NotificationChannelLike
  if (body.notificationId !== undefined && body.notificationId !== null) {
    try {
      const doc = (await ctx.payload.findByID({
        collection: 'notifications',
        id: parseDocId(ctx.payload, String(body.notificationId)),
        depth: 0,
        user: ctx.user,
        overrideAccess: false,
      })) as Notification
      const org = typeof doc.organization === 'object' ? doc.organization.id : doc.organization
      if (String(org) !== String(ctx.orgId)) throw new Error('wrong organization')
      channel = doc
    } catch {
      return jsonError(404, 'Notification channel not found', { ok: false })
    }
  } else if (typeof body.type === 'string') {
    channel = {
      type: body.type,
      config: (body.config ?? {}) as Notification['config'],
      name: typeof body.name === 'string' ? body.name : undefined,
    }
  } else {
    return jsonError(400, 'Provide notificationId or type + config', { ok: false })
  }

  try {
    const result = await sendTestNotification(ctx.payload, channel)
    return Response.json({ ok: true, result })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return Response.json({ ok: false, error: message }, { status: 400 })
  }
}
