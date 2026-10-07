import {
  NO_STORE,
  errorJson,
  loadSubscription,
  publicSubscription,
  readBody,
} from '@/server/status-pages/subscribers/http'
import { unsubscribe, updateSubscriptionComponents } from '@/server/status-pages/subscribers/signup'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ slug: string; token: string }> }

/**
 * `/api/status-pages/:slug/subscriptions/:token` — the subscription behind a signed link. The token
 * is the credential, so these work on password-protected pages without the access cookie.
 *
 * - `GET`: `{ channel, target, components, confirmed }`
 * - `PATCH` `{ components: string[] }`: follow these components (empty = all)
 * - `DELETE`: unsubscribe
 */
export async function GET(request: Request, { params }: RouteContext) {
  const { slug, token } = await params
  const ctx = await loadSubscription(slug, token)
  if (!ctx) return errorJson(request, 'subscriptionNotFound', 404)
  return Response.json(publicSubscription(ctx.subscriber), { headers: NO_STORE })
}

export async function PATCH(request: Request, { params }: RouteContext) {
  const { slug, token } = await params
  const ctx = await loadSubscription(slug, token)
  if (!ctx) return errorJson(request, 'subscriptionNotFound', 404)
  const body = await readBody(request)
  const updated = await updateSubscriptionComponents(
    ctx.payload,
    ctx.page,
    ctx.subscriber,
    body?.components,
  )
  if (!updated) return errorJson(request, 'subscriberComponentsInvalid', 400)
  return Response.json(publicSubscription(updated), { headers: NO_STORE })
}

export async function DELETE(request: Request, { params }: RouteContext) {
  const { slug, token } = await params
  const ctx = await loadSubscription(slug, token)
  if (!ctx) return errorJson(request, 'subscriptionNotFound', 404)
  await unsubscribe(ctx.payload, ctx.subscriber)
  return Response.json({ ok: true }, { headers: NO_STORE })
}
