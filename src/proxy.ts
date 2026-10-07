import { NextResponse, type NextRequest } from 'next/server'

/**
 * Status page URL rewrites (Next.js 16 "proxy", formerly middleware).
 *
 * On every host, Markdown aliases that a route segment cannot express are rewritten:
 *
 *   /status/<slug>.md                 → /status/<slug>/index.md
 *   /status/<slug>/incidents/<id>.md  → /status/<slug>/incident-md/<id>
 *
 * Custom domains: when a request arrives on a host that is not Marmot's own (`NEXT_PUBLIC_SERVER_URL`),
 * the host is looked up through `GET /api/status-pages/resolve-domain?host=` (cached for 60 s by
 * `fetch`). When it belongs to a published status page the page's public paths are rewritten to it:
 *
 *   https://status.example.com/              → /status/<slug>
 *   https://status.example.com/rss           → /status/<slug>/rss
 *   https://status.example.com/feed/atom     → /status/<slug>/feed/atom (and every other path in
 *                                              `CUSTOM_DOMAIN_PATHS`: feeds, `maintenance.ics`,
 *                                              `api/v2/*.json`, `api/openapi.json`, `index.md`,
 *                                              `llms.txt`, `manifest.json`, `login`)
 *   https://status.example.com/incidents/7   → /status/<slug>/incidents/7
 *   https://status.example.com/incidents/7.md → /status/<slug>/incident-md/7
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
    '/index.md',
    '/llms.txt',
    '/maintenance.ics',
    '/feed/:path*',
    '/api/v2/:path*',
    '/api/openapi.json',
    '/incidents/:path*',
    '/status/:path*',
  ],
}

/** Paths served at the root of a custom domain, exactly (`''` is the page itself). */
export const CUSTOM_DOMAIN_PATHS: Record<string, string> = {
  '/': '',
  '/rss': '/rss',
  '/manifest.json': '/manifest.json',
  '/login': '/login',
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

const SLUG = '[a-z0-9-]+'
const ID = '[A-Za-z0-9_-]+'
const PAGE_MARKDOWN = new RegExp(`^/status/(${SLUG})\\.md$`)
const INCIDENT_MARKDOWN = new RegExp(`^/status/(${SLUG})/incidents/(${ID})\\.md$`)
const ROOT_INCIDENT_MARKDOWN = new RegExp(`^/incidents/(${ID})\\.md$`)
const ROOT_INCIDENT = new RegExp(`^/incidents/(${ID})$`)

/** Rewrite of a Markdown alias under `/status/…` (any host), or null. */
export function markdownAliasRewrite(pathname: string): string | null {
  const page = PAGE_MARKDOWN.exec(pathname)
  if (page) return `/status/${page[1]}/index.md`
  const incident = INCIDENT_MARKDOWN.exec(pathname)
  if (incident) return `/status/${incident[1]}/incident-md/${incident[2]}`
  return null
}

/** Path below `/status/<slug>` that a custom-domain path maps to, or null when it is not one. */
export function customDomainSuffix(pathname: string): string | null {
  if (Object.prototype.hasOwnProperty.call(CUSTOM_DOMAIN_PATHS, pathname)) {
    return CUSTOM_DOMAIN_PATHS[pathname]
  }
  const markdown = ROOT_INCIDENT_MARKDOWN.exec(pathname)
  if (markdown) return `/incident-md/${markdown[1]}`
  const incident = ROOT_INCIDENT.exec(pathname)
  if (incident) return `/incidents/${incident[1]}`
  return null
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
    if (!alias) return NextResponse.next()
    const target = request.nextUrl.clone()
    target.pathname = alias
    return NextResponse.rewrite(target)
  }

  const suffix = customDomainSuffix(pathname)
  if (suffix === null) return NextResponse.next()

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
