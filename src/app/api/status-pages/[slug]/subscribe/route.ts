import { getPayload } from 'payload'

import config from '@payload-config'
import { resolveStatusPageLocale } from '@/i18n/resolve'
import { requestLocale } from '@/server/request-locale'
import {
  accessDeniedResponse,
  accessRequestFrom,
  checkStatusPageAccess,
} from '@/server/status-pages/access'
import { findPublishedStatusPage } from '@/server/status-pages/public'
import { NO_STORE, errorJson, readBody } from '@/server/status-pages/subscribers/http'
import { offeredChannels, subscribe } from '@/server/status-pages/subscribers/signup'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ slug: string }> }

/**
 * POST /api/status-pages/:slug/subscribe — `{ channel, target, components? }`.
 *
 * Anonymous, for visitors who may view the page (protected pages need the access cookie). Answers
 * `202 { ok: true, next }` where `next` is `confirm-email`, `enter-code` or `done`, whatever the
 * address's previous state, so the endpoint cannot tell who is subscribed. `400` for an invalid
 * target or components, `404` when the page does not offer that channel, `429` when rate limited.
 */
export async function POST(request: Request, { params }: RouteContext) {
  const { slug } = await params
  const payload = await getPayload({ config })
  const page = await findPublishedStatusPage(payload, slug)
  if (!page) return errorJson(request, 'statusPageNotFound', 404)

  const access = await checkStatusPageAccess(payload, page, accessRequestFrom(request), {
    acceptPasswordParam: false,
  })
  if (!access.allowed) return accessDeniedResponse(access, 'json', requestLocale(request))
  if (offeredChannels(page).length === 0) return errorJson(request, 'subscriptionsUnavailable', 404)

  const body = await readBody(request)
  if (!body) return errorJson(request, 'invalidJsonBody', 400)

  const result = await subscribe(
    payload,
    page,
    { channel: body.channel, target: body.target, components: body.components },
    request,
    resolveStatusPageLocale(page, request.headers),
  )
  if (result.ok) return Response.json(result, { status: 202, headers: NO_STORE })
  switch (result.error) {
    case 'unavailable':
      return errorJson(request, 'subscriptionChannelUnavailable', 404)
    case 'invalid-target':
      return errorJson(request, 'subscriberTargetInvalid', 400)
    case 'invalid-components':
      return errorJson(request, 'subscriberComponentsInvalid', 400)
    case 'rate-limited':
      return errorJson(request, 'tooManyAttempts', 429, {
        'Retry-After': String(result.retryAfterSeconds),
      })
  }
}
