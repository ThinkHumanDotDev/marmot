import { env } from '@/env'
import { eventPath, type EventKind } from '@/lib/status-page-events'

/** `NEXT_PUBLIC_SERVER_URL` without a trailing slash. */
export const serverUrl = (): string => env.NEXT_PUBLIC_SERVER_URL.replace(/\/$/, '')

/** Public URL of a status page on the main host. */
export const statusPagePath = (slug: string): string => `/status/${encodeURIComponent(slug)}`
export const statusPageUrl = (slug: string): string => `${serverUrl()}${statusPagePath(slug)}`

/**
 * Absolute permalink of an incident or maintenance window on Marmot's own host (for emails and
 * other links that leave the request context, e.g. subscriber notifications, #104).
 */
export const statusPageEventUrl = (slug: string, kind: EventKind, publicId: string): string =>
  `${statusPageUrl(slug)}${eventPath(kind, publicId)}`

type PageWithDomains = { slug: string; domains?: { hostname: string }[] | null }

/** Hostname the visitor used (behind a proxy: `X-Forwarded-Host`), lower-cased, without port. */
export function requestHostname(headers: Headers): string {
  const header = headers.get('x-forwarded-host') ?? headers.get('host') ?? ''
  return (header.split(',')[0]?.trim().toLowerCase() ?? '').replace(/:\d+$/, '')
}

/** True when the request arrived on one of the page's custom domains. */
export const isCustomDomainRequest = (page: PageWithDomains, headers: Headers): boolean => {
  const host = requestHostname(headers)
  return (page.domains ?? []).some((d) => d.hostname === host)
}

/**
 * Path of the page as the visitor sees it: `''` (the root) on a custom domain, where the proxy
 * rewrites `/`, `/rss`, `/login`, `/events/…` and the other page paths (`src/proxy.ts`);
 * `/status/<slug>` everywhere else.
 */
export const statusPageBasePath = (page: PageWithDomains, headers: Headers): string =>
  isCustomDomainRequest(page, headers) ? '' : statusPagePath(page.slug)

/**
 * Public URL of a status page for the request at hand: when the request arrived on one of the
 * page's custom domains (the proxy rewrote `/` to `/status/<slug>`), links stay on that domain.
 * Any other host (the main site, an internal `web:3000`, a test harness) uses the configured URL.
 * `fallbackProtocol` is used on custom domains when no `X-Forwarded-Proto` is present.
 */
export function statusPageUrlForHeaders(
  page: PageWithDomains,
  headers: Headers,
  fallbackProtocol = 'https:',
): string {
  if (isCustomDomainRequest(page, headers)) {
    const forwarded = headers.get('x-forwarded-proto')?.split(',')[0]?.trim()
    const protocol = forwarded ? `${forwarded}:` : fallbackProtocol
    return `${protocol}//${requestHostname(headers)}`
  }
  return statusPageUrl(page.slug)
}

/** `statusPageUrlForHeaders` for a route handler's request. */
export const statusPageUrlFor = (page: PageWithDomains, request: Request): string =>
  statusPageUrlForHeaders(page, request.headers, new URL(request.url).protocol)
