import { getPayload } from 'payload'

import config from '@payload-config'
import {
  accessCookie,
  accessDeniedResponse,
  attemptStatusPagePassword,
  isSecureRequest,
  protectedHeaders,
  signAccessToken,
  type PasswordAttempt,
} from '@/server/status-pages/access'
import { findPublishedStatusPage } from '@/server/status-pages/public'
import { requestHostname, statusPageBasePath } from '@/server/status-pages/urls'
import { errorText, requestLocale } from '@/server/request-locale'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ slug: string }> }

type Body = { password: string | null; form: boolean }

async function readBody(request: Request): Promise<Body> {
  const type = request.headers.get('content-type') ?? ''
  if (type.includes('application/json')) {
    const json = (await request.json().catch(() => null)) as { password?: unknown } | null
    return { password: typeof json?.password === 'string' ? json.password : null, form: false }
  }
  const data = await request.formData().catch(() => null)
  const password = data?.get('password')
  return { password: typeof password === 'string' ? password : null, form: true }
}

/** A cross-site form post: the `Origin` (when sent) must be the host the request arrived on. */
function crossSite(request: Request): boolean {
  const origin = request.headers.get('origin')
  if (!origin || origin === 'null') return Boolean(origin)
  try {
    return new URL(origin).hostname.toLowerCase() !== requestHostname(request.headers)
  } catch {
    return true
  }
}

const redirect = (location: string, headers: Record<string, string> = {}) =>
  new Response(null, {
    status: 303,
    headers: { ...protectedHeaders(), ...headers, Location: location },
  })

/**
 * POST /api/status-pages/:slug/access — sign in to a password-protected status page.
 *
 * Accepts the login form (`application/x-www-form-urlencoded` / `multipart/form-data`, field
 * `password`) or JSON `{ "password": "…" }`. A correct password sets the page's HttpOnly access
 * cookie. Forms are redirected (303) back to the page, or to its login page with `?error=invalid`
 * / `?error=rate-limited`; JSON callers get `{ ok: true }`, or 401 / 429 with `{ error, code }`. Rate limited per page and
 * client (see `attemptStatusPagePassword`).
 */
export async function POST(request: Request, { params }: RouteContext) {
  const { slug } = await params
  if (crossSite(request)) {
    return Response.json(
      { error: errorText(request, 'crossSiteRefused') },
      { status: 403, headers: protectedHeaders() },
    )
  }

  const payload = await getPayload({ config })
  const page = await findPublishedStatusPage(payload, slug)
  const body = await readBody(request)

  if (!page) {
    return Response.json(
      { error: errorText(request, 'statusPageNotFound') },
      { status: 404, headers: protectedHeaders() },
    )
  }

  const base = statusPageBasePath(page, request.headers)
  const pagePath = base || '/'
  if (page.access !== 'password') {
    return body.form
      ? redirect(pagePath)
      : Response.json({ ok: true }, { headers: protectedHeaders() })
  }

  const attempt: PasswordAttempt = body.password
    ? await attemptStatusPagePassword(payload, page, body.password, request)
    : { ok: false, reason: 'invalid-password' }

  if (!attempt.ok) {
    if (!body.form)
      return accessDeniedResponse({ allowed: false, ...attempt }, 'json', requestLocale(request))
    const error = attempt.reason === 'rate-limited' ? 'rate-limited' : 'invalid'
    const retry: Record<string, string> = attempt.retryAfterSeconds
      ? { 'Retry-After': String(attempt.retryAfterSeconds) }
      : {}
    return redirect(`${base}/login?error=${error}`, retry)
  }

  const cookie = accessCookie(page.id, await signAccessToken(page), {
    secure: isSecureRequest(request),
  })
  if (body.form) return redirect(pagePath, { 'Set-Cookie': cookie })
  return Response.json({ ok: true }, { headers: { ...protectedHeaders(), 'Set-Cookie': cookie } })
}
