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
import { consumeMagicLink, requestMagicLink } from '@/server/status-pages/magic-link'
import { findPublishedStatusPage } from '@/server/status-pages/public'
import { requestHostname, statusPageBasePath } from '@/server/status-pages/urls'
import { errorText, requestLocale } from '@/server/request-locale'

import type { StatusPage } from '@/payload-types'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ slug: string }> }

type Body = {
  password: string | null
  email: string | null
  token: string | null
  form: boolean
}

const str = (value: unknown): string | null => (typeof value === 'string' ? value : null)

async function readBody(request: Request): Promise<Body> {
  const type = request.headers.get('content-type') ?? ''
  if (type.includes('application/json')) {
    const json = (await request.json().catch(() => null)) as Record<string, unknown> | null
    return {
      password: str(json?.password),
      email: str(json?.email),
      token: str(json?.token),
      form: false,
    }
  }
  const data = await request.formData().catch(() => null)
  return {
    password: str(data?.get('password')),
    email: str(data?.get('email')),
    token: str(data?.get('token')),
    form: true,
  }
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

const retryHeaders = (seconds?: number): Record<string, string> =>
  seconds ? { 'Retry-After': String(seconds) } : {}

interface Ctx {
  request: Request
  page: StatusPage
  body: Body
  base: string
  pagePath: string
}

/** Signs the visitor in: sets the page's access cookie and sends them to the page. */
async function grant({ request, page, body, pagePath }: Ctx, viewer?: string | number) {
  const cookie = accessCookie(page.id, await signAccessToken(page, { viewer }), {
    secure: isSecureRequest(request),
  })
  if (body.form) return redirect(pagePath, { 'Set-Cookie': cookie })
  return Response.json({ ok: true }, { headers: { ...protectedHeaders(), 'Set-Cookie': cookie } })
}

async function passwordLogin(ctx: Ctx) {
  const { request, page, body, base } = ctx
  const payload = await getPayload({ config })
  const attempt: PasswordAttempt = body.password
    ? await attemptStatusPagePassword(payload, page, body.password, request)
    : { ok: false, reason: 'invalid-password' }

  if (!attempt.ok) {
    if (!body.form) {
      return accessDeniedResponse({ allowed: false, ...attempt }, 'json', requestLocale(request))
    }
    const error = attempt.reason === 'rate-limited' ? 'rate-limited' : 'invalid'
    return redirect(`${base}/login?error=${error}`, retryHeaders(attempt.retryAfterSeconds))
  }
  return grant(ctx)
}

async function emailDomainLogin(ctx: Ctx) {
  const { request, page, body, base } = ctx
  const payload = await getPayload({ config })

  // Step 2: the visitor opened the link and confirmed.
  if (body.token) {
    const result = await consumeMagicLink(payload, page, body.token)
    if (result.ok) return grant(ctx, result.viewer.id)
    if (body.form) return redirect(`${base}/login?error=link-invalid`)
    return Response.json(
      { error: errorText(request, 'statusPageLinkInvalid'), code: 'link-invalid' },
      { status: 400, headers: protectedHeaders() },
    )
  }

  // Step 1: send a link. The answer never depends on whether the address is admitted.
  const result = await requestMagicLink(payload, page, body.email, request)
  if (!result.ok) {
    if (result.reason === 'rate-limited') {
      if (!body.form) {
        return accessDeniedResponse(
          {
            allowed: false,
            reason: 'rate-limited',
            retryAfterSeconds: result.retryAfterSeconds,
          },
          'json',
          requestLocale(request),
        )
      }
      return redirect(`${base}/login?error=rate-limited`, retryHeaders(result.retryAfterSeconds))
    }
    if (body.form) return redirect(`${base}/login?error=invalid-email`)
    return Response.json(
      { error: errorText(request, 'invalidEmailAddress'), code: 'invalid-email' },
      { status: 400, headers: protectedHeaders() },
    )
  }
  if (body.form) return redirect(`${base}/login?sent=1`)
  return Response.json({ ok: true, sent: true }, { status: 202, headers: protectedHeaders() })
}

/**
 * POST /api/status-pages/:slug/access — sign in to a protected status page.
 *
 * Accepts the login forms (`application/x-www-form-urlencoded` / `multipart/form-data`) or JSON.
 * Forms are redirected (303) back to the page or to its login page (with `?error=…` or `?sent=1`);
 * JSON callers get a JSON answer. Cross-site form posts are refused.
 *
 * - `password` pages: field `password`. A correct password sets the page's HttpOnly access cookie
 *   (`{ ok: true }`); otherwise 401 / 429 with `{ error, code }` (`?error=invalid|rate-limited`).
 *   Rate limited per page and client (see `attemptStatusPagePassword`).
 * - `email-domain` pages: field `email` asks for a sign-in link: 202 `{ ok: true, sent: true }`
 *   (`?sent=1`) whether or not the address is admitted, 400 `invalid-email` for something that is
 *   not an address, 429 when rate limited per client and per address. Field `token` redeems a
 *   link: the access cookie, or 400 `link-invalid` (`?error=link-invalid`). See `magic-link.ts`.
 * - Other modes have nothing to sign in to: `{ ok: true }` / redirect to the page.
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
  const ctx: Ctx = { request, page, body, base, pagePath: base || '/' }

  switch (page.access) {
    case 'password':
      return passwordLogin(ctx)
    case 'email-domain':
      return emailDomainLogin(ctx)
    default:
      return body.form
        ? redirect(ctx.pagePath)
        : Response.json({ ok: true }, { headers: protectedHeaders() })
  }
}
