import { env } from '@/env'

/** `NEXT_PUBLIC_SERVER_URL` without a trailing slash. */
export const serverUrl = (): string => env.NEXT_PUBLIC_SERVER_URL.replace(/\/$/, '')

/** Public URL of a status page on the main host. */
export const statusPagePath = (slug: string): string => `/status/${encodeURIComponent(slug)}`
export const statusPageUrl = (slug: string): string => `${serverUrl()}${statusPagePath(slug)}`

/**
 * Public URL of a status page for the request at hand: when the request arrived on one of the
 * page's custom domains (the proxy rewrote `/` to `/status/<slug>`), links stay on that domain.
 * Any other host (the main site, an internal `web:3000`, a test harness) uses the configured URL.
 */
export function statusPageUrlFor(
  page: { slug: string; domains?: { hostname: string }[] | null },
  request: Request,
): string {
  const header = request.headers.get('x-forwarded-host') ?? request.headers.get('host') ?? ''
  const host = header.split(',')[0]?.trim().toLowerCase().replace(/:\d+$/, '')
  const custom = (page.domains ?? []).some((d) => d.hostname === host)
  if (custom) {
    const forwarded = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim()
    const protocol = forwarded ? `${forwarded}:` : new URL(request.url).protocol
    return `${protocol}//${host}`
  }
  return statusPageUrl(page.slug)
}
