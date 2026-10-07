import { isChannelEvent } from '@/lib/notification-events'
import type { Notification } from '@/payload-types'
import { getNotificationProvider } from '@/server/notification-providers'
import { jsonError, parseDocId, readJson, resolveOrgRequest } from '@/server/notifications/api'
import { previewNotification } from '@/server/notifications/preview'
import { getChannelOrganization } from '@/server/notifications/send'
import { errorText } from '@/server/request-locale'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ orgId: string }> }

type PreviewBody = {
  notificationId?: string | number
  type?: string
  config?: unknown
  event?: unknown
}

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

/**
 * POST /api/orgs/:orgId/notifications/preview — render a channel's message templates against
 * sample data (#150). Nothing is sent (`notification:read`).
 *
 * Body: `{ type, config, event }` for the form's unsaved settings, or `{ notificationId, event }`
 * for a saved channel (`config` overrides its settings). `event` picks the sample (`down` by
 * default). The config does not have to be complete. Responds with `NotificationPreview`: the
 * default message, each template's output or error, and the email of email providers. Texts are
 * in the organization's language, like real messages.
 */
export async function POST(request: Request, { params }: RouteContext) {
  const { orgId } = await params
  const ctx = await resolveOrgRequest(request, orgId, 'notification:read')
  if (ctx instanceof Response) return ctx

  const body = await readJson<PreviewBody>(request)
  if (!body) return jsonError(400, errorText(request, 'invalidJsonBody'))

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
      return jsonError(404, errorText(request, 'notificationChannelNotFound'))
    }
  }

  const type = saved?.type ?? body.type
  if (typeof type !== 'string' || !getNotificationProvider(type)) {
    return jsonError(400, errorText(request, 'notificationTestTargetRequired'))
  }
  const config = asRecord(body.config !== undefined ? body.config : saved?.config)
  const event = isChannelEvent(body.event) ? body.event : 'down'
  const org = await getChannelOrganization(ctx.payload, {
    organization: ctx.orgId as Notification['organization'],
  })
  return Response.json(previewNotification(type, config, event, org))
}
