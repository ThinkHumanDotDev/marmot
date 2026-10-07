import { statusPagePath } from '@/server/status-pages/urls'
import {
  NO_STORE,
  errorJson,
  isFormRequest,
  loadSubscription,
} from '@/server/status-pages/subscribers/http'
import { unsubscribe } from '@/server/status-pages/subscribers/signup'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ slug: string; token: string }> }

/**
 * POST /api/status-pages/:slug/subscriptions/:token/unsubscribe — one-click unsubscribe.
 *
 * The `List-Unsubscribe` target of every email (RFC 8058: mail clients POST
 * `List-Unsubscribe=One-Click` without cookies or redirects) and the action of the unsubscribe
 * page's form, which is redirected back to `/status/:slug/unsubscribe/:token?done=1`. Idempotent:
 * an already removed subscription answers like a successful one.
 */
export async function POST(request: Request, { params }: RouteContext) {
  const { slug, token } = await params
  const ctx = await loadSubscription(slug, token)
  if (ctx) await unsubscribe(ctx.payload, ctx.subscriber)

  const body = isFormRequest(request) ? await request.text().catch(() => '') : ''
  const oneClick = body.includes('List-Unsubscribe=One-Click')
  if (isFormRequest(request) && !oneClick) {
    return new Response(null, {
      status: 303,
      headers: {
        ...NO_STORE,
        Location: `${statusPagePath(slug)}/unsubscribe/${encodeURIComponent(token)}?done=1`,
      },
    })
  }
  if (!ctx && !oneClick) return errorJson(request, 'subscriptionNotFound', 404)
  return Response.json({ ok: true }, { headers: NO_STORE })
}
