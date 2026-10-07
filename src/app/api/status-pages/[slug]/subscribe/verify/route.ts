import { getPayload } from 'payload'

import config from '@payload-config'
import { requestLocale } from '@/server/request-locale'
import {
  accessDeniedResponse,
  accessRequestFrom,
  checkStatusPageAccess,
} from '@/server/status-pages/access'
import { findPublishedStatusPage } from '@/server/status-pages/public'
import { NO_STORE, errorJson, readBody } from '@/server/status-pages/subscribers/http'
import { subscriptionLinks } from '@/server/status-pages/subscribers/links'
import { verifySmsCode } from '@/server/status-pages/subscribers/signup'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ slug: string }> }

/**
 * POST /api/status-pages/:slug/subscribe/verify — `{ target, code }`: confirms an SMS sign-up with
 * the code it received. `200 { ok: true, manageUrl }`, `400` for a wrong, expired or exhausted code
 * (five tries), `429` when rate limited.
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

  const body = await readBody(request)
  if (!body) return errorJson(request, 'invalidJsonBody', 400)
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
    return errorJson(request, 'tooManyAttempts', 429, {
      'Retry-After': String(result.retryAfterSeconds),
    })
  }
  return errorJson(request, 'subscriptionCodeInvalid', 400)
}
