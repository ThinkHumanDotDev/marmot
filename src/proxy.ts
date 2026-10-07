import { NextResponse, type NextRequest } from 'next/server'

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
 *                                              the history `events`, `sitemap.xml`, `robots.txt`,
 *                                              the feeds, `maintenance.ics`, `api/v2/*.json`,
 *                                              `api/openapi.json`, `index.md`, `llms.txt`)
 *   https://status.example.com/events/incident/<id>    → /status/<slug>/events/incident/<id>
 *   https://status.example.com/events/maintenance/<id> → /status/<slug>/events/maintenance/<id>
 *   https://status.example.com/events/incident/<id>.md → /status/<slug>/event-md/incident/<id>
 *
 * Everything else (the app, API, admin) is untouched, and any failure falls through to the normal
 * routing so a broken lookup can never take the main site down. See docs/Status-Pages.md.
 */

export const config = {
  matcher: [
    '/',
    '/rss',
    '/manifest.json',
    '/login',
    '/badge.svg',
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

async function resolveSlug(request: NextRequest, host: string): Promise<string | null> {
  const url = new URL('/api/status-pages/resolve-domain', request.nextUrl.origin)
  url.searchParams.set('host', host)
  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
    next: { revalidate: 60 },
  })
  if (!res.ok) return null
  const body = (await res.json()) as { slug?: unknown }
  return typeof body.slug === 'string' && /^[a-z0-9-]+$/.test(body.slug) ? body.slug : null
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl
  if (pathname.startsWith('/status/')) {
    const alias = markdownAliasRewrite(pathname)
    if (alias === undefined) return NextResponse.next()
    const target = request.nextUrl.clone()
    target.pathname = alias
    return NextResponse.rewrite(target)
  }

  const suffix = customDomainSuffix(pathname)
  if (suffix === undefined) return NextResponse.next()

  const host = requestHostname(request)
  const own = serverHostname()
  if (!HOSTNAME.test(host) || host === own || host === 'localhost') return NextResponse.next()

  try {
    const slug = await resolveSlug(request, host)
    if (!slug) return NextResponse.next()
    const target = request.nextUrl.clone()
    target.pathname = `/status/${slug}${suffix}`
    return NextResponse.rewrite(target)
  } catch {
    return NextResponse.next()
  }
}
