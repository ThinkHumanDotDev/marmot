import { NextResponse, type NextRequest } from 'next/server'

import {
  EMBED_PARAM,
  EMBED_THEME_HEADER,
  EMBED_THEME_PARAM,
  FRAME_ANCESTORS_NONE,
  frameHeaders,
  isFrameAncestorsValue,
  parseEmbedTheme,
} from '@/lib/status-page-embed'

/**
 * Status page URL rewrites (Next.js 16 "proxy", formerly middleware).
 *
 * On every host, Markdown aliases that a route segment cannot express are rewritten:
 *
 *   /status/<slug>.md                               → /status/<slug>/index.md
 *   /status/<slug>/events/<kind>/<publicId>.md      → /status/<slug>/event-md/<kind>/<publicId>
 *
 * Custom domains: when a request arrives on a host that is not Marmot's own (`NEXT_PUBLIC_SERVER_URL`),
 * the host is looked up through `GET /api/status-pages/resolve-domain?host=` (cached for 60 s by
 * `fetch`). When it belongs to a published status page the page's public paths are rewritten to it:
 *
 *   https://status.example.com/              → /status/<slug>
 *   https://status.example.com/rss           → /status/<slug>/rss (and every other path in
 *                                              `REWRITES`: `manifest.json`, `login`, `badge.svg`,
 *                                              `widget.js`, the history `events`, `sitemap.xml`,
 *                                              `robots.txt`,
 *                                              the feeds, `maintenance.ics`, `api/v2/*.json`,
 *                                              `api/openapi.json`, `index.md`, `llms.txt`)
 *   https://status.example.com/events/incident/<id>    → /status/<slug>/events/incident/<id>
 *   https://status.example.com/events/maintenance/<id> → /status/<slug>/events/maintenance/<id>
 *   https://status.example.com/events/incident/<id>.md → /status/<slug>/event-md/incident/<id>
 *
 * Everything else (the app, API, admin) is untouched, and any failure falls through to the normal
 * routing so a broken lookup can never take the main site down. See docs/Status-Pages.md.
 *
 * Framing (#109): the page itself (`/status/<slug>`, or `/` on its custom domain) gets the
 * `Content-Security-Policy: frame-ancestors …` of its `allowEmbedding` setting, looked up through
 * `GET /api/status-pages/:slug/embed-policy` (or with the domain, cached for 60 s); every other
 * response below `/status/` and every rewritten path gets `frame-ancestors 'none'` and
 * `X-Frame-Options: DENY`. A failed lookup also denies framing. `?embed=…&theme=` on the page is
 * passed to the layout as the `x-marmot-embed-theme` request header.
 */

export const config = {
  matcher: [
    '/',
    '/rss',
    '/manifest.json',
    '/login',
    '/badge.svg',
    '/widget.js',
    '/events',
    '/events/:kind/:id',
    '/sitemap.xml',
    '/robots.txt',
    '/index.md',
    '/llms.txt',
    '/maintenance.ics',
    '/feed/:path*',
    '/api/v2/:path*',
    '/api/openapi.json',
    '/status/:path*',
  ],
}

/** Paths served at the root of a custom domain, exactly (`''` is the page itself). */
const REWRITES: Record<string, string> = {
  '/': '',
  '/rss': '/rss',
  '/manifest.json': '/manifest.json',
  '/login': '/login',
  '/badge.svg': '/badge.svg',
  '/widget.js': '/widget.js',
  '/events': '/events',
  '/sitemap.xml': '/sitemap.xml',
  '/robots.txt': '/robots.txt',
  '/index.md': '/index.md',
  '/llms.txt': '/llms.txt',
  '/maintenance.ics': '/maintenance.ics',
  '/feed/atom': '/feed/atom',
  '/feed/json': '/feed/json',
  '/api/openapi.json': '/api/openapi.json',
  '/api/v2/summary.json': '/api/v2/summary.json',
  '/api/v2/status.json': '/api/v2/status.json',
  '/api/v2/components.json': '/api/v2/components.json',
  '/api/v2/incidents.json': '/api/v2/incidents.json',
  '/api/v2/scheduled-maintenances.json': '/api/v2/scheduled-maintenances.json',
}

/** Permalinks of incidents and maintenance windows (`src/lib/status-page-events.ts`). */
const EVENT_PERMALINK = /^\/events\/(incident|maintenance)\/[0-9a-z]{8}$/
/** Their Markdown versions. */
const EVENT_MARKDOWN = /^\/events\/(incident|maintenance)\/([0-9a-z]{8})\.md$/
const PAGE_MARKDOWN = /^\/status\/([a-z0-9-]+)\.md$/
const PAGE_EVENT_MARKDOWN =
  /^\/status\/([a-z0-9-]+)\/events\/(incident|maintenance)\/([0-9a-z]{8})\.md$/

/** Rewrite of a Markdown alias under `/status/…` (any host), or undefined. */
export function markdownAliasRewrite(pathname: string): string | undefined {
  const page = PAGE_MARKDOWN.exec(pathname)
  if (page) return `/status/${page[1]}/index.md`
  const event = PAGE_EVENT_MARKDOWN.exec(pathname)
  if (event) return `/status/${event[1]}/event-md/${event[2]}/${event[3]}`
  return undefined
}

/** The path below `/status/<slug>` that `pathname` maps to on a custom domain, or undefined. */
export function customDomainSuffix(pathname: string): string | undefined {
  if (Object.hasOwn(REWRITES, pathname)) return REWRITES[pathname]
  if (EVENT_PERMALINK.test(pathname)) return pathname
  const markdown = EVENT_MARKDOWN.exec(pathname)
  if (markdown) return `/event-md/${markdown[1]}/${markdown[2]}`
  return undefined
}

const HOSTNAME = /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(?:\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/

function serverHostname(): string | null {
  try {
    return new URL(process.env.NEXT_PUBLIC_SERVER_URL || 'http://localhost:3000').hostname
  } catch {
    return null
  }
}

/** Hostname of the request as the visitor typed it (behind Caddy: `X-Forwarded-Host`). */
function requestHostname(request: NextRequest): string {
  const forwarded = request.headers.get('x-forwarded-host')
  const raw = (forwarded ?? request.headers.get('host') ?? request.nextUrl.host)
    .split(',')[0]
    .trim()
    .toLowerCase()
  return raw.replace(/:\d+$/, '')
}

interface ResolvedDomain {
  slug: string
  frameAncestors: string
}

async function resolveDomain(request: NextRequest, host: string): Promise<ResolvedDomain | null> {
  const url = new URL('/api/status-pages/resolve-domain', request.nextUrl.origin)
  url.searchParams.set('host', host)
  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
    next: { revalidate: 60 },
  })
  if (!res.ok) return null
  const body = (await res.json()) as { slug?: unknown; frameAncestors?: unknown }
  if (typeof body.slug !== 'string' || !/^[a-z0-9-]+$/.test(body.slug)) return null
  return {
    slug: body.slug,
    frameAncestors: isFrameAncestorsValue(body.frameAncestors)
      ? body.frameAncestors
      : FRAME_ANCESTORS_NONE,
  }
}

/** The page itself (`/status/<slug>`), the only path below `/status/` that may ever be framed. */
const PAGE_PATH = /^\/status\/([a-z0-9-]+)\/?$/

/**
 * `frame-ancestors` of the page `slug` (`GET /api/status-pages/:slug/embed-policy`, cached for 60 s);
 * `'none'` when the lookup fails, so a broken lookup never opens a page to framing.
 */
async function embedPolicy(request: NextRequest, slug: string): Promise<string> {
  try {
    const url = new URL(`/api/status-pages/${slug}/embed-policy`, request.nextUrl.origin)
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      next: { revalidate: 60 },
    })
    if (!res.ok) return FRAME_ANCESTORS_NONE
    const body = (await res.json()) as { frameAncestors?: unknown }
    return isFrameAncestorsValue(body.frameAncestors) ? body.frameAncestors : FRAME_ANCESTORS_NONE
  } catch {
    return FRAME_ANCESTORS_NONE
  }
}

/**
 * Request headers passed on to the page: the visitor's own, minus any `x-marmot-embed-theme`, plus
 * that header with `?theme=` when the page is opened in embed mode (the layout sets the theme from
 * it; layouts cannot read the query string).
 */
function pageRequestHeaders(request: NextRequest, isPage: boolean): Headers {
  const headers = new Headers(request.headers)
  headers.delete(EMBED_THEME_HEADER)
  const params = request.nextUrl.searchParams
  if (isPage && params.has(EMBED_PARAM)) {
    const theme = parseEmbedTheme(params.get(EMBED_THEME_PARAM))
    if (theme) headers.set(EMBED_THEME_HEADER, theme)
  }
  return headers
}

function withFrameHeaders(response: NextResponse, frameAncestors: string): NextResponse {
  for (const [name, value] of Object.entries(frameHeaders(frameAncestors))) {
    response.headers.set(name, value)
  }
  return response
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl
  if (pathname.startsWith('/status/')) {
    // Framing (#109): the page follows its `allowEmbedding` setting, everything else below
    // `/status/` (login, subscription management, feeds, …) is never framed.
    const page = PAGE_PATH.exec(pathname)
    const headers = pageRequestHeaders(request, page !== null)
    const alias = markdownAliasRewrite(pathname)
    if (alias !== undefined) {
      const target = request.nextUrl.clone()
      target.pathname = alias
      return withFrameHeaders(
        NextResponse.rewrite(target, { request: { headers } }),
        FRAME_ANCESTORS_NONE,
      )
    }
    const frameAncestors = page ? await embedPolicy(request, page[1]) : FRAME_ANCESTORS_NONE
    return withFrameHeaders(NextResponse.next({ request: { headers } }), frameAncestors)
  }

  const suffix = customDomainSuffix(pathname)
  if (suffix === undefined) return NextResponse.next()

  const host = requestHostname(request)
  const own = serverHostname()
  if (!HOSTNAME.test(host) || host === own || host === 'localhost') return NextResponse.next()

  try {
    const resolved = await resolveDomain(request, host)
    if (!resolved) return NextResponse.next()
    const target = request.nextUrl.clone()
    target.pathname = `/status/${resolved.slug}${suffix}`
    const isPage = suffix === ''
    return withFrameHeaders(
      NextResponse.rewrite(target, { request: { headers: pageRequestHeaders(request, isPage) } }),
      isPage ? resolved.frameAncestors : FRAME_ANCESTORS_NONE,
    )
  } catch {
    return NextResponse.next()
  }
}
