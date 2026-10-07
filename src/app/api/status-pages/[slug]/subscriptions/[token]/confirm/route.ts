import { statusPagePath } from '@/server/status-pages/urls'
import {
  NO_STORE,
  errorJson,
  isFormRequest,
  loadSubscription,
} from '@/server/status-pages/subscribers/http'
import { subscriptionLinks } from '@/server/status-pages/subscribers/links'
import { confirmSubscription } from '@/server/status-pages/subscribers/signup'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ slug: string; token: string }> }

/**
 * POST /api/status-pages/:slug/subscriptions/:token/confirm — email double opt-in. The confirm page
 * (`/status/:slug/confirm/:token`) posts here from a button, so link scanners that prefetch the
 * email's link never confirm. Forms are redirected to the manage page; JSON gets `{ ok, manageUrl }`.
 */
export async function POST(request: Request, { params }: RouteContext) {
  const { slug, token } = await params
  const ctx = await loadSubscription(slug, token)
  if (!ctx) {
    if (isFormRequest(request)) {
      return new Response(null, {
        status: 303,
        headers: {
          ...NO_STORE,
          Location: `${statusPagePath(slug)}/confirm/${encodeURIComponent(token)}`,
        },
      })
    }
    return errorJson(request, 'subscriptionNotFound', 404)
  }
  await confirmSubscription(ctx.payload, ctx.subscriber)
  if (isFormRequest(request)) {
    return new Response(null, {
      status: 303,
      headers: {
        ...NO_STORE,
        Location: `${statusPagePath(slug)}/manage/${encodeURIComponent(token)}?confirmed=1`,
      },
    })
  }
  return Response.json(
    { ok: true, manageUrl: subscriptionLinks(ctx.page, ctx.subscriber).manageUrl },
    { headers: NO_STORE },
  )
}
