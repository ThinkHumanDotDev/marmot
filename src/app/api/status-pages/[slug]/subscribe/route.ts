import { getPayload } from 'payload'

import config from '@payload-config'
import { isLocale } from '@/i18n/locales'
import { offeredLocales } from '@/lib/status-page-locales'
import {
  accessDeniedResponse,
  accessRequestFrom,
  checkStatusPageAccess,
} from '@/server/status-pages/access'
import { scopePageForVisitor } from '@/server/status-pages/audiences'
import { findPublishedStatusPage } from '@/server/status-pages/public'
import { NO_STORE, errorJson, readBody } from '@/server/status-pages/subscribers/http'
import { offeredChannels, subscribe } from '@/server/status-pages/subscribers/signup'
import { visitorLocale } from '@/server/status-pages/visitor-locale'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ slug: string }> }

/**
 * POST /api/status-pages/:slug/subscribe — `{ channel, target, components?, locale? }`.
 * `locale` is the language the visitor reads the page in; messages to the subscriber use it when
 * the page offers it, else the page's default language.
 *
 * Anonymous, for visitors who may view the page (protected pages need the access cookie). Answers
 * `202 { ok: true, next }` where `next` is `confirm-email`, `enter-code` or `done`, whatever the
 * address's previous state, so the endpoint cannot tell who is subscribed. `400` for an invalid
 * target or components, `404` when the page does not offer that channel, `429` when rate limited.
 * Errors are in the page's language (`?locale=`, then `locale`, else the page default; #271).
 */
export async function POST(request: Request, { params }: RouteContext) {
  const { slug } = await params
  const payload = await getPayload({ config })
  const found = await findPublishedStatusPage(payload, slug)
  if (!found) return errorJson(visitorLocale(request), 'statusPageNotFound', 404)
  const pageLocale = visitorLocale(request, found)

  const access = await checkStatusPageAccess(payload, found, accessRequestFrom(request), {
    acceptPasswordParam: false,
  })
  if (!access.allowed) return accessDeniedResponse(access, 'json', pageLocale)
  // Audience pages (#151): components of the visitor's audiences only, and the subscription is
  // bound to those audiences (from the session, never from the body).
  const page = scopePageForVisitor(found, access)
  if (offeredChannels(page).length === 0) {
    return errorJson(pageLocale, 'subscriptionsUnavailable', 404)
  }

  const body = await readBody(request)
  if (!body) return errorJson(pageLocale, 'invalidJsonBody', 400)
  // The language the visitor reads the page in: messages to the subscriber and errors use it.
  const locale = isLocale(body.locale, offeredLocales(page)) ? body.locale : pageLocale

  const result = await subscribe(
    payload,
    page,
    {
      channel: body.channel,
      target: body.target,
      components: body.components,
      audiences: access.audience?.audiences,
    },
    request,
    locale,
  )
  if (result.ok) return Response.json(result, { status: 202, headers: NO_STORE })
  switch (result.error) {
    case 'unavailable':
      return errorJson(locale, 'subscriptionChannelUnavailable', 404)
    case 'invalid-target':
      return errorJson(locale, 'subscriberTargetInvalid', 400)
    case 'invalid-components':
      return errorJson(locale, 'subscriberComponentsInvalid', 400)
    case 'rate-limited':
      return errorJson(locale, 'tooManyAttempts', 429, {
        'Retry-After': String(result.retryAfterSeconds),
      })
  }
}
