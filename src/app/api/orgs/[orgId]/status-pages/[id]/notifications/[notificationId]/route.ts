import type { SubscriberDelivery } from '@/payload-types'
import { errorResponse, jsonError, readJson } from '@/server/status-pages/http'
import { errorText } from '@/server/request-locale'
import {
  BatchStateError,
  applyBatchAction,
  deliveryCounts,
  loadPageContext,
  previewBatch,
  type BatchAction,
} from '@/server/status-pages/subscribers/batches'
import {
  loadOwnerNotification,
  ownerContext,
  ownerDelivery,
  ownerNotification,
} from '@/server/status-pages/subscribers/owner'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ orgId: string; id: string; notificationId: string }> }

/**
 * GET /api/orgs/:orgId/status-pages/:id/notifications/:notificationId — the notification with its
 * rendered email and SMS, the recipients it would reach now (per channel), delivery counts and the
 * last 100 deliveries (failed first). Needs `subscriber:read`.
 */
export async function GET(request: Request, { params }: RouteContext) {
  const { orgId, id, notificationId } = await params
  const owner = await ownerContext(request, orgId, id, 'subscriber:read')
  if (!owner.ok) return owner.response
  try {
    const notification = await loadOwnerNotification(owner.ctx, notificationId)
    if (!notification) return jsonError(errorText(request, 'subscriberNotificationNotFound'), 404)
    const pageCtx = await loadPageContext(owner.ctx.payload, owner.ctx.page.id)
    if (!pageCtx) return jsonError(errorText(request, 'statusPageNotFound'), 404)
    const [preview, counts, deliveries] = await Promise.all([
      previewBatch(owner.ctx.payload, notification, pageCtx),
      deliveryCounts(owner.ctx.payload, notification.id),
      owner.ctx.payload.find({
        collection: 'subscriber-deliveries',
        where: { notification: { equals: notification.id } },
        sort: 'state',
        limit: 100,
        depth: 1,
        user: owner.ctx.user,
        overrideAccess: false,
      }),
    ])
    return Response.json({
      doc: ownerNotification(notification),
      preview: {
        email: preview.email,
        sms: preview.sms,
        recipients: preview.recipients,
        smsUnavailable: preview.smsUnavailable,
      },
      deliveries: {
        counts,
        docs: (deliveries.docs as SubscriberDelivery[]).map(ownerDelivery),
      },
    })
  } catch (error) {
    return errorResponse(error, request)
  }
}

const ACTIONS: readonly BatchAction[] = ['send', 'discard', 'retry']

/**
 * POST /api/orgs/:orgId/status-pages/:id/notifications/:notificationId — `{ action }`:
 * `send` (approve a draft), `discard` (drop a draft) or `retry` (re-send failed deliveries).
 * Needs `subscriber:send` (admins by default); `409` when the state does not allow the action.
 */
export async function POST(request: Request, { params }: RouteContext) {
  const { orgId, id, notificationId } = await params
  const owner = await ownerContext(request, orgId, id, 'subscriber:send')
  if (!owner.ok) return owner.response
  const body = await readJson(request)
  const action = body?.action as BatchAction | undefined
  if (!action || !ACTIONS.includes(action)) {
    return jsonError(errorText(request, 'invalidJsonBody'), 400)
  }
  try {
    const notification = await loadOwnerNotification(owner.ctx, notificationId)
    if (!notification) return jsonError(errorText(request, 'subscriberNotificationNotFound'), 404)
    const doc = await applyBatchAction(owner.ctx.payload, notification, action, owner.ctx.user.id)
    return Response.json({ doc: ownerNotification(doc) })
  } catch (error) {
    if (error instanceof BatchStateError) {
      return jsonError(
        errorText(request, 'subscriberNotificationState', { action: error.action }),
        409,
      )
    }
    return errorResponse(error, request)
  }
}
