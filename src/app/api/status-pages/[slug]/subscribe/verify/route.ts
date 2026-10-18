import { getPayload } from 'payload'

import config from '@payload-config'
import {
  accessDeniedResponse,
  accessRequestFrom,
  checkStatusPageAccess,
} from '@/server/status-pages/access'
import { findPublishedStatusPage } from '@/server/status-pages/public'
import { NO_STORE, errorJson, readBody } from '@/server/status-pages/subscribers/http'
import { subscriptionLinks } from '@/server/status-pages/subscribers/links'
import { verifySmsCode } from '@/server/status-pages/subscribers/signup'
import { visitorLocale } from '@/server/status-pages/visitor-locale'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ slug: string }> }

/**
 * POST /api/status-pages/:slug/subscribe/verify — `{ target, code }`: confirms an SMS sign-up with
 * the code it received. `200 { ok: true, manageUrl }`, `400` for a wrong, expired or exhausted code
 * (five tries), `429` when rate limited. Errors are in the page's language (`?locale=`, #271).
 */
export async function POST(request: Request, { params }: RouteContext) {
  const { slug } = await params
  const payload = await getPayload({ config })
  const page = await findPublishedStatusPage(payload, slug)
  if (!page) return errorJson(visitorLocale(request), 'statusPageNotFound', 404)
  const locale = visitorLocale(request, page)

  const access = await checkStatusPageAccess(payload, page, accessRequestFrom(request), {
    acceptPasswordParam: false,
  })
  if (!access.allowed) return accessDeniedResponse(access, 'json', locale)

  const body = await readBody(request)
  if (!body) return errorJson(locale, 'invalidJsonBody', 400)
  const result = await verifySmsCode(
    payload,
    page,
    { target: body.target, code: body.code },
    request,
  )
  if (result.ok) {
    return Response.json(
      { ok: true, manageUrl: subscriptionLinks(page, result.subscriber).manageUrl },
      { headers: NO_STORE },
    )
  }
  if (result.error === 'rate-limited') {
    return errorJson(locale, 'tooManyAttempts', 429, {
      'Retry-After': String(result.retryAfterSeconds),
    })
  }
  return errorJson(locale, 'subscriptionCodeInvalid', 400)
}
