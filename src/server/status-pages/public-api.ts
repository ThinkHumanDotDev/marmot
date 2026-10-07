/**
 * Response plumbing of the public read-only endpoints of a status page (feeds, the iCalendar feed,
 * the Statuspage-compatible JSON, Markdown, `llms.txt`, the OpenAPI document). Every one of them:
 *
 * - loads the published page and runs `checkStatusPageAccess` (every access mode: password, email
 *   domain, IP allow-list), so protected pages answer 401 / 403 (429 while rate limited) and are never
 *   stored by shared caches;
 * - answers errors as RFC 9457 `application/problem+json`;
 * - sends `Cache-Control` matched to the page's auto-refresh interval plus `stale-while-revalidate`,
 *   a weak `ETag` of the body (`If-None-Match` → 304), and CORS `*` with the `ETag` exposed.
 *
 * Bodies must be deterministic for unchanged data (no "generated at now" fields), otherwise the
 * `ETag` changes on every request.
 */
import { createHash } from 'node:crypto'

import { getPayload, type Payload } from 'payload'

import config from '@payload-config'
import { defaultLocale, type Locale } from '@/i18n/locales'
import { resolveStatusPageLocale } from '@/i18n/resolve'
import type { StatusPage } from '@/payload-types'
import { translateError, type ErrorKey } from '@/server/errors'
import { requestLocale } from '@/server/request-locale'

import {
  accessRequestFrom,
  checkStatusPageAccess,
  DENIAL_MESSAGES,
  DENIAL_STATUS,
  PROTECTED_CACHE_CONTROL,
  type StatusPageAccessDecision,
} from './access'
import { findPublishedStatusPage } from './public'
import { statusPageLinksFor, type StatusPageLinks } from './urls'

export type GrantedAccess = Extract<StatusPageAccessDecision, { allowed: true }>

/** Shortest and longest `max-age` of public responses, in seconds. */
export const MIN_PUBLIC_MAX_AGE = 30
export const MAX_PUBLIC_MAX_AGE = 300

/**
 * `max-age` of a page's public responses: its auto-refresh interval (what the page itself polls
 * with), clamped to 30–300 s; pages that never refresh use 300 s.
 */
export function publicMaxAge(page: Pick<StatusPage, 'autoRefreshInterval'>): number {
  const interval = Math.floor(page.autoRefreshInterval ?? 0)
  if (interval <= 0) return MAX_PUBLIC_MAX_AGE
  return Math.min(MAX_PUBLIC_MAX_AGE, Math.max(MIN_PUBLIC_MAX_AGE, interval))
}

/** `public, max-age=N, stale-while-revalidate=N` for public pages, `private, no-store` otherwise. */
export function publicCacheControl(
  page: Pick<StatusPage, 'autoRefreshInterval'>,
  access: GrantedAccess,
): string {
  if (access.restricted) return PROTECTED_CACHE_CONTROL
  const maxAge = publicMaxAge(page)
  return `public, max-age=${maxAge}, stale-while-revalidate=${maxAge}`
}

export const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Expose-Headers': 'ETag',
}

/** `OPTIONS` handler: CORS preflight for `If-None-Match` requests. */
export function corsPreflight(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      ...CORS_HEADERS,
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      'Access-Control-Allow-Headers': 'If-None-Match',
      'Access-Control-Max-Age': '86400',
    },
  })
}

/** Weak validator of a body: `W/"<sha-256, base64url, 27 chars>"`. */
export const weakEtag = (body: string): string =>
  `W/"${createHash('sha256').update(body).digest('base64url').slice(0, 27)}"`

/** True when `If-None-Match` lists `etag` (weak comparison, RFC 9110 §13.1.2) or is `*`. */
export function etagMatches(ifNoneMatch: string | null, etag: string): boolean {
  if (!ifNoneMatch) return false
  const opaque = (tag: string) => tag.trim().replace(/^W\//, '')
  const wanted = opaque(etag)
  return ifNoneMatch.split(',').some((tag) => tag.trim() === '*' || opaque(tag) === wanted)
}

const STATUS_TITLES: Record<number, string> = {
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
}

export interface Problem {
  status: number
  /** Localised explanation (`detail`). */
  detail: string
  /** Stable machine-readable code (extension member). */
  code?: string
  headers?: Record<string, string>
}

/** RFC 9457 problem details (`type: about:blank`, `title` is the HTTP status phrase). */
export function problemResponse(request: Request, problem: Problem): Response {
  const body = {
    type: 'about:blank',
    title: STATUS_TITLES[problem.status] ?? 'Error',
    status: problem.status,
    detail: problem.detail,
    instance: new URL(request.url).pathname,
    ...(problem.code ? { code: problem.code } : {}),
  }
  return new Response(JSON.stringify(body), {
    status: problem.status,
    headers: {
      'Content-Type': 'application/problem+json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...CORS_HEADERS,
      ...problem.headers,
    },
  })
}

/**
 * 401 (sign-in required), 403 (IP not allowed) or 429 (rate limited) as problem details, with the
 * protected-page headers. Status and message come from `checkStatusPageAccess`'s denial table.
 */
export function accessProblem(
  request: Request,
  decision: Extract<StatusPageAccessDecision, { allowed: false }>,
  locale: Locale = defaultLocale,
): Response {
  return problemResponse(request, {
    status: DENIAL_STATUS[decision.reason],
    detail: translateError(locale, DENIAL_MESSAGES[decision.reason]),
    code: decision.reason,
    headers: {
      'X-Robots-Tag': 'noindex, nofollow',
      ...(decision.retryAfterSeconds ? { 'Retry-After': String(decision.retryAfterSeconds) } : {}),
    },
  })
}

export const notFoundProblem = (request: Request, key: ErrorKey = 'statusPageNotFound') =>
  problemResponse(request, {
    status: 404,
    detail: translateError(requestLocale(request), key),
    code: 'not-found',
  })

export interface PublicDocument {
  body: string
  contentType: string
}

export interface PublicEndpointContext {
  payload: Payload
  page: StatusPage
  access: GrantedAccess
  /** Locale of the response (the page's language, or the visitor's for `auto` pages). */
  locale: Locale
  links: StatusPageLinks
  request: Request
}

/**
 * Serves one public representation of the page `slug`. `build` returns the document, or a
 * `Response` for its own errors (e.g. `notFoundProblem` for an unknown incident).
 */
export async function servePublicStatusPage(
  request: Request,
  slug: string,
  build: (ctx: PublicEndpointContext) => Promise<PublicDocument | Response>,
): Promise<Response> {
  const payload = await getPayload({ config })
  const page = await findPublishedStatusPage(payload, slug)
  if (!page) return notFoundProblem(request)

  const access = await checkStatusPageAccess(payload, page, accessRequestFrom(request))
  if (!access.allowed) return accessProblem(request, access, requestLocale(request))

  const result = await build({
    payload,
    page,
    access,
    locale: resolveStatusPageLocale(page, request.headers),
    links: statusPageLinksFor(page, request),
    request,
  })
  if (result instanceof Response) return result
  return documentResponse(request, page, access, result)
}

/** 200 with the document, or 304 when the client already has it. */
export function documentResponse(
  request: Request,
  page: Pick<StatusPage, 'autoRefreshInterval'>,
  access: GrantedAccess,
  document: PublicDocument,
): Response {
  const etag = weakEtag(document.body)
  const headers: Record<string, string> = {
    'Cache-Control': publicCacheControl(page, access),
    ETag: etag,
    // `auto` pages render in the visitor's language; the access cookie decides protected pages.
    Vary: 'Accept-Language, Cookie',
    ...CORS_HEADERS,
    ...(access.restricted ? { 'X-Robots-Tag': 'noindex, nofollow' } : {}),
  }
  if (etagMatches(request.headers.get('if-none-match'), etag)) {
    return new Response(null, { status: 304, headers })
  }
  return new Response(document.body, {
    status: 200,
    headers: { ...headers, 'Content-Type': document.contentType },
  })
}

export type SlugRouteContext = { params: Promise<{ slug: string }> }

/** Route handler (`GET`) for `/status/[slug]/…` that serves `build`'s document. */
export const publicStatusPageRoute =
  (build: (ctx: PublicEndpointContext) => Promise<PublicDocument | Response>) =>
  async (request: Request, { params }: SlugRouteContext): Promise<Response> => {
    const { slug } = await params
    return servePublicStatusPage(request, slug, build)
  }

export const jsonDocument = (
  data: unknown,
  contentType = 'application/json; charset=utf-8',
): PublicDocument => ({ body: JSON.stringify(data), contentType })

export const markdownDocument = (body: string): PublicDocument => ({
  body,
  contentType: 'text/markdown; charset=utf-8',
})
