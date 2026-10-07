import { env } from '@/env'

/** `NEXT_PUBLIC_SERVER_URL` without a trailing slash. */
export const serverUrl = (): string => env.NEXT_PUBLIC_SERVER_URL.replace(/\/$/, '')

/** Public URL of a status page on the main host. */
export const statusPagePath = (slug: string): string => `/status/${encodeURIComponent(slug)}`
export const statusPageUrl = (slug: string): string => `${serverUrl()}${statusPagePath(slug)}`

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
 * rewrites `/`, `/rss`, `/login` and `/manifest.json`; `/status/<slug>` everywhere else.
 */
export const statusPageBasePath = (page: PageWithDomains, headers: Headers): string =>
  isCustomDomainRequest(page, headers) ? '' : statusPagePath(page.slug)

/**
 * Public URL of a status page for the request at hand: when the request arrived on one of the
 * page's custom domains (the proxy rewrote `/` to `/status/<slug>`), links stay on that domain.
 * Any other host (the main site, an internal `web:3000`, a test harness) uses the configured URL.
 */
export function statusPageUrlFor(page: PageWithDomains, request: Request): string {
  if (isCustomDomainRequest(page, request.headers)) {
    const forwarded = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim()
    const protocol = forwarded ? `${forwarded}:` : new URL(request.url).protocol
    return `${protocol}//${requestHostname(request.headers)}`
  }
  return statusPageUrl(page.slug)
}
