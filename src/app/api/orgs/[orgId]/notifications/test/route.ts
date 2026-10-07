import { normalizeChannelEvents } from '@/lib/notification-events'
import type { Notification } from '@/payload-types'
import { jsonError, parseDocId, readJson, resolveOrgRequest } from '@/server/notifications/api'
import {
  normalizeNotificationConfig,
  sendTestNotification,
  validateNotificationConfig,
  validateNotificationTemplates,
  type NotificationChannelLike,
} from '@/server/notifications/send'
import { checkServerSmtpChange, ServerSmtpSendError } from '@/server/notifications/server-smtp'
import { serverTranslator } from '@/server/i18n'
import { OK_MESSAGE } from '@/server/notification-providers/http'
import { errorText, requestLocale } from '@/server/request-locale'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ orgId: string }> }

type TestBody = {
  notificationId?: string | number
  type?: string
  config?: unknown
  name?: string
  /** Unsaved event selection (the edit form); defaults to the saved channel's. */
  events?: unknown
}

/**
 * POST /api/orgs/:orgId/notifications/test — send a test message (`notification:update`).
 *
 * Body: `{ notificationId }` for a saved channel, `{ type, config, name? }` for an unsaved one, or
 * `{ notificationId, config, name? }` for unsaved edits of a saved channel (the edit form); `events`
 * overrides the selection. One sample is sent per selected event (#126), stopping at the first
 * failure. Responds `{ ok: true, result, events }` or 400 `{ ok: false, error }` with the
 * provider's message; 403 when the caller may not set up the channel as given (server SMTP
 * settings), 429 when the organization spent its hourly budget for the server SMTP settings.
 */
export async function POST(request: Request, { params }: RouteContext) {
  const { orgId } = await params
  const ctx = await resolveOrgRequest(request, orgId, 'notification:update')
  if (ctx instanceof Response) return ctx

  const body = await readJson<TestBody>(request)
  if (!body) return jsonError(400, errorText(request, 'invalidJsonBody'), { ok: false })

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
      return jsonError(404, errorText(request, 'notificationChannelNotFound'), { ok: false })
    }
  } else if (typeof body.type !== 'string') {
    return jsonError(400, errorText(request, 'notificationTestTargetRequired'), { ok: false })
  }

  // Samples follow the form's unsaved selection, else the saved channel's, else the defaults.
  const events = Array.isArray(body.events)
    ? normalizeChannelEvents(body.events)
    : normalizeChannelEvents(saved?.events)

  let channel: NotificationChannelLike
  if (saved && body.config === undefined) {
    channel = { ...saved, events }
  } else {
    // Unsaved settings: the same rules as saving them (a new channel, or an edit of `saved`).
    const type = saved?.type ?? (body.type as string)
    channel = {
      type,
      config: (body.config ?? {}) as Notification['config'],
      name: typeof body.name === 'string' ? body.name : (saved?.name ?? undefined),
      events,
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
    if (refusal) {
      return jsonError(refusal.status, errorText(request, refusal.key, refusal.values), {
        ok: false,
      })
    }
  }

  try {
    // Unsaved templates get the same check as saving them; a bad one is not silently replaced
    // by the default message in a test.
    if (body.config !== undefined) {
      validateNotificationTemplates(
        channel.type,
        validateNotificationConfig(channel.type, channel.config),
        requestLocale(request),
        saved,
      )
    }
    const { result, events: sent } = await sendTestNotification(ctx.payload, channel)
    // Providers report success with Kuma's fixed text; show it in the user's language.
    return Response.json({
      ok: true,
      result:
        result === OK_MESSAGE
          ? serverTranslator(requestLocale(request))('notifications.messages.sentSuccessfully')
          : result,
      events: sent,
    })
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
