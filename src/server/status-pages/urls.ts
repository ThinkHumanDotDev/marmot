import { env } from '@/env'
import { isLocale, type Locale } from '@/i18n/locales'
import { EVENTS_PATH, eventPath, type EventKind } from '@/lib/status-page-events'
import {
  localePrefix,
  offeredLocales,
  prefixedLocale,
  STATUS_LOCALE_HEADER,
  type LocalizedPage,
} from '@/lib/status-page-locales'

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

type PageWithDomains = LocalizedPage & { slug: string; domains?: { hostname: string }[] | null }

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

/** The language prefix of the request (`/fr`), or `''` for the page's default language. */
const requestLocalePrefix = (page: PageWithDomains, headers: Headers): string => {
  const locale = prefixedLocale(page, headers)
  return locale ? localePrefix(page, locale) : ''
}

/** `/status/<slug>` with the request's language prefix (`/status/<slug>/fr`), on any host. */
export const statusPageLocalePath = (page: PageWithDomains, headers: Headers): string =>
  `${statusPagePath(page.slug)}${requestLocalePrefix(page, headers)}`

/**
 * Path of the page without its language prefix: `''` (the root) on a custom domain, where the
 * proxy rewrites `/`, `/rss`, `/login`, `/events/…` and the other page paths (`src/proxy.ts`);
 * `/status/<slug>` everywhere else.
 */
export const statusPageRootPath = (page: PageWithDomains, headers: Headers): string =>
  isCustomDomainRequest(page, headers) ? '' : statusPagePath(page.slug)

/**
 * Path of the page as the visitor sees it, in the request's language: `statusPageRootPath`
 * followed by the language prefix (`/status/<slug>/fr`, `/fr` on a custom domain). Links built on
 * it keep the visitor in their language.
 */
export const statusPageBasePath = (page: PageWithDomains, headers: Headers): string =>
  `${statusPageRootPath(page, headers)}${requestLocalePrefix(page, headers)}`

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
  return `${statusPageRootUrl(page, headers, fallbackProtocol)}${requestLocalePrefix(page, headers)}`
}

/** `statusPageUrlForHeaders` without the language prefix (the page in its default language). */
export function statusPageRootUrl(
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

/**
 * The headers of an API request to a page's endpoints (`/api/status-pages/:slug/…`, which the
 * proxy does not see) with the language of its `?locale=` parameter, so links and emails built
 * from them stay in the language of the page the visitor came from.
 */
export function headersWithRequestedLocale(request: Request): Headers {
  const headers = new Headers(request.headers)
  const locale = new URL(request.url).searchParams.get('locale')
  if (isLocale(locale)) headers.set(STATUS_LOCALE_HEADER, locale)
  else headers.delete(STATUS_LOCALE_HEADER)
  return headers
}

/** `statusPageUrlForHeaders` for a route handler's request. */
export const statusPageUrlFor = (page: PageWithDomains, request: Request): string =>
  statusPageUrlForHeaders(page, request.headers, new URL(request.url).protocol)

/**
 * `hreflang` alternates of a page path (`''`, `/events`, a permalink) for every offered language,
 * plus `x-default` (the default language, which has no prefix), as absolute URLs.
 */
export function localeAlternates(
  page: PageWithDomains,
  headers: Headers,
  path = '',
): Record<string, string> {
  const root = statusPageRootUrl(page, headers)
  const offered = offeredLocales(page)
  const url = (locale: Locale) => `${root}${localePrefix(page, locale)}${path}`
  return {
    ...Object.fromEntries(offered.map((locale) => [locale, url(locale)])),
    'x-default': url(offered[0]!),
  }
}

/**
 * Permalink of an incident below a page URL (`statusPageUrlFor` / `statusPageUrl`):
 * `<page>/events/incident/<publicId>` (#107). `publicId` is the incident's public id, never its
 * database id.
 */
export const incidentPermalink = (pageUrl: string, publicId: string): string =>
  `${pageUrl}${eventPath('incident', publicId)}`

/** Permalink of a maintenance occurrence below a page URL: `<page>/events/maintenance/<publicId>`. */
export const maintenancePermalink = (pageUrl: string, publicId: string): string =>
  `${pageUrl}${eventPath('maintenance', publicId)}`

export const STATUSPAGE_ENDPOINTS = [
  'summary',
  'status',
  'components',
  'incidents',
  'scheduled-maintenances',
] as const
export type StatuspageEndpoint = (typeof STATUSPAGE_ENDPOINTS)[number]

/** The public read-only endpoints of a page, as absolute URLs below `pageUrl`. */
export interface StatusPageLinks {
  page: string
  /** History page (#107). */
  events: string
  rss: string
  atom: string
  jsonFeed: string
  calendar: string
  /** The page as Markdown (`/status/<slug>.md`, `/index.md` on a custom domain). */
  markdown: string
  llms: string
  openapi: string
  /** Statuspage-compatible JSON (`summary.json`, `status.json`, …). */
  api: (name: StatuspageEndpoint) => string
  /** Permalink of an event (`kind` + public id) and its Markdown version (`….md`). */
  event: (kind: EventKind, publicId: string) => string
  eventMarkdown: (kind: EventKind, publicId: string) => string
}

/**
 * Links of a page: on its custom domain everything hangs off the root (the proxy rewrites these
 * paths), elsewhere off `/status/<slug>`. `indexMarkdown` links the Markdown version as
 * `<page>/index.md` instead of `<page>.md` (custom domains and language prefixes).
 */
export function statusPageLinks(pageUrl: string, indexMarkdown: boolean): StatusPageLinks {
  return {
    page: pageUrl,
    events: `${pageUrl}${EVENTS_PATH}`,
    rss: `${pageUrl}/rss`,
    atom: `${pageUrl}/feed/atom`,
    jsonFeed: `${pageUrl}/feed/json`,
    calendar: `${pageUrl}/maintenance.ics`,
    markdown: indexMarkdown ? `${pageUrl}/index.md` : `${pageUrl}.md`,
    llms: `${pageUrl}/llms.txt`,
    openapi: `${pageUrl}/api/openapi.json`,
    api: (name) => `${pageUrl}/api/v2/${name}.json`,
    event: (kind, publicId) => `${pageUrl}${eventPath(kind, publicId)}`,
    eventMarkdown: (kind, publicId) => `${pageUrl}${eventPath(kind, publicId)}.md`,
  }
}

/**
 * `statusPageLinks` for the request at hand. Below a language prefix the Markdown version is
 * `…/fr/index.md`, like on a custom domain (`/status/<slug>/fr.md` is not a page path).
 */
export const statusPageLinksFor = (page: PageWithDomains, request: Request): StatusPageLinks =>
  statusPageLinks(
    statusPageUrlFor(page, request),
    isCustomDomainRequest(page, request.headers) ||
      requestLocalePrefix(page, request.headers) !== '',
  )
