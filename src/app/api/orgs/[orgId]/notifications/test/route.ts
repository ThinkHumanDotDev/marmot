import type { Notification } from '@/payload-types'
import { jsonError, parseDocId, readJson, resolveOrgRequest } from '@/server/notifications/api'
import {
  normalizeNotificationConfig,
  sendTestNotification,
  type NotificationChannelLike,
} from '@/server/notifications/send'
import { checkServerSmtpChange, ServerSmtpSendError } from '@/server/notifications/server-smtp'

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
 * Body: `{ notificationId }` for a saved channel, `{ type, config, name? }` for an unsaved one, or
 * `{ notificationId, config, name? }` for unsaved edits of a saved channel (the edit form).
 * Responds `{ ok: true, result }` or 400 `{ ok: false, error }` with the provider's message; 403
 * when the caller may not set up the channel as given (server SMTP settings), 429 when the
 * organization spent its hourly budget for the server SMTP settings.
 */
export async function POST(request: Request, { params }: RouteContext) {
  const { orgId } = await params
  const ctx = await resolveOrgRequest(request, orgId, 'notification:update')
  if (ctx instanceof Response) return ctx

  const body = await readJson<TestBody>(request)
  if (!body) return jsonError(400, 'Invalid JSON body', { ok: false })

  let saved: Notification | null = null
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
      saved = doc
    } catch {
      return jsonError(404, 'Notification channel not found', { ok: false })
    }
  } else if (typeof body.type !== 'string') {
    return jsonError(400, 'Provide notificationId or type + config', { ok: false })
  }

  let channel: NotificationChannelLike
  if (saved && body.config === undefined) {
    channel = saved
  } else {
    // Unsaved settings: the same rules as saving them (a new channel, or an edit of `saved`).
    const type = saved?.type ?? (body.type as string)
    channel = {
      type,
      config: (body.config ?? {}) as Notification['config'],
      name: typeof body.name === 'string' ? body.name : (saved?.name ?? undefined),
      organization: ctx.orgId as Notification['organization'],
    }
    const refusal = checkServerSmtpChange({
      operation: saved ? 'update' : 'create',
      type,
      config: normalizeNotificationConfig(type, channel.config),
      originalType: saved?.type,
      originalConfig: saved ? normalizeNotificationConfig(saved.type, saved.config) : undefined,
      user: ctx.user,
    })
    if (refusal) return jsonError(refusal.status, refusal.message, { ok: false })
  }

  try {
    const result = await sendTestNotification(ctx.payload, channel)
    return Response.json({ ok: true, result })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (error instanceof ServerSmtpSendError && error.reason === 'rate-limited') {
      return Response.json(
        { ok: false, error: message },
        { status: 429, headers: { 'Retry-After': String(error.retryAfterSeconds) } },
      )
    }
    return Response.json({ ok: false, error: message }, { status: 400 })
  }
}
