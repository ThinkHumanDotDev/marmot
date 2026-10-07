import { NextResponse, type NextRequest } from 'next/server'

/**
 * Custom domains for status pages (Next.js 16 "proxy", formerly middleware).
 *
 * When a request arrives on a host that is not Marmot's own (`NEXT_PUBLIC_SERVER_URL`), the host is
 * looked up through `GET /api/status-pages/resolve-domain?host=` (cached for 60 s by `fetch`). When
 * it belongs to a published status page the root paths are rewritten to that page:
 *
 *   https://status.example.com/              → /status/<slug>
 *   https://status.example.com/rss           → /status/<slug>/rss
 *   https://status.example.com/manifest.json → /status/<slug>/manifest.json
 *   https://status.example.com/badge.svg     → /status/<slug>/badge.svg
 *
 * Everything else (the app, API, admin) is untouched, and any failure falls through to the normal
 * routing so a broken lookup can never take the main site down. See docs/Status-Pages.md.
 */

export const config = {
  matcher: ['/', '/rss', '/manifest.json', '/badge.svg'],
}

const REWRITES: Record<string, string> = {
  '/': '',
  '/rss': '/rss',
  '/manifest.json': '/manifest.json',
  '/badge.svg': '/badge.svg',
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
  const suffix = REWRITES[request.nextUrl.pathname]
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
