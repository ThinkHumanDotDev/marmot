import {
  defaultLocale,
  isLocale,
  locales,
  matchLocale,
  parseAcceptLanguage,
  readCookie,
  type Locale,
} from '@/i18n/locales'

/**
 * Languages and time zones of a public status page (#114). Pure helpers shared by the proxy, the
 * server routes and the visitor's locale and time zone switchers, so they must stay free of
 * Next.js and Payload imports.
 *
 * URLs: the page's default language has no prefix (`/status/<slug>/events`); every other offered
 * language lives under its code (`/status/<slug>/fr/events`, `/fr/events` on a custom domain). The
 * proxy strips the prefix before routing and passes it on in `STATUS_LOCALE_HEADER`.
 */

/** Request header carrying the URL's locale prefix from the proxy to the status page routes. */
export const STATUS_LOCALE_HEADER = 'x-marmot-status-locale'

/** Request header carrying the path the visitor asked for (before rewrites), with its query. */
export const STATUS_PATH_HEADER = 'x-marmot-status-path'

/** Cookie with the language a visitor picked in a status page's language switcher. */
export const STATUS_LOCALE_COOKIE = 'marmot-status-locale'

/** One year, like the app's `marmot-locale` cookie. */
export const STATUS_LOCALE_COOKIE_MAX_AGE = 365 * 24 * 60 * 60

/** localStorage key of the time zone a visitor picked in the footer (`''` = the page default). */
export const STATUS_TIME_ZONE_STORAGE_KEY = 'marmot-status-time-zone'

/** The status page fields that decide its languages. */
export interface LocalizedPage {
  defaultLocale?: string | null
  locales?: readonly string[] | null
}

/** The page's default language: its `defaultLocale` when shipped, else `en`. */
export const pageDefaultLocale = (page: LocalizedPage | null | undefined): Locale =>
  isLocale(page?.defaultLocale) ? page.defaultLocale : defaultLocale

/**
 * Languages the page offers, default first, then `locales` in their order. Unknown values (a
 * language that is no longer shipped) are dropped.
 */
export function offeredLocales(page: LocalizedPage | null | undefined): Locale[] {
  const offered: Locale[] = [pageDefaultLocale(page)]
  for (const locale of page?.locales ?? []) {
    if (isLocale(locale) && !offered.includes(locale)) offered.push(locale)
  }
  return offered
}

/** `''` for the page's default language, `/<locale>` for the others. */
export const localePrefix = (page: LocalizedPage | null | undefined, locale: Locale): string =>
  locale === pageDefaultLocale(page) ? '' : `/${locale}`

/**
 * A path below a page split into its locale prefix and the rest: `/fr/events` → `fr`, `/events`;
 * `/fr` → `fr`, `''`; `/events` → null, `/events`. Only shipped locales count as prefixes.
 */
export function splitLocalePrefix(path: string): { locale: Locale | null; rest: string } {
  const match = /^\/([a-z]{2}(?:-[A-Z]{2})?)(?=\/|$)(.*)$/.exec(path)
  if (match && isLocale(match[1])) return { locale: match[1], rest: match[2] ?? '' }
  return { locale: null, rest: path }
}

/** The locale a request asked for through its URL prefix, when the page offers it. */
export function prefixedLocale(page: LocalizedPage | null | undefined, headers: Headers) {
  const value = headers.get(STATUS_LOCALE_HEADER)
  return isLocale(value, offeredLocales(page)) ? value : null
}

/**
 * Language a page is rendered in for a request: the URL prefix when the page offers it, otherwise
 * the page's default (the plain URL always shows the default language, so it can be cached and
 * indexed as such). Without a page (404s), the visitor's choice or browser decides among all
 * shipped languages.
 */
export function statusPageLocaleFor(
  page: LocalizedPage | null | undefined,
  headers: Headers,
): Locale {
  if (!page) return visitorLocale(locales, headers) ?? defaultLocale
  return prefixedLocale(page, headers) ?? pageDefaultLocale(page)
}

/** The visitor's switcher choice, then `Accept-Language`, among `offered`; null when none match. */
function visitorLocale(offered: readonly Locale[], headers: Headers): Locale | null {
  const chosen = readCookie(headers.get('cookie'), STATUS_LOCALE_COOKIE)
  if (isLocale(chosen, offered)) return chosen
  return matchLocale(parseAcceptLanguage(headers.get('accept-language')), offered) ?? null
}

/**
 * Where a visitor should be sent on a plain (unprefixed) page URL: the language they picked in the
 * switcher earlier, else the best `Accept-Language` match among the offered languages. Returns
 * null when that is the default language, or when the URL already has a prefix.
 */
export function preferredLocaleRedirect(
  page: LocalizedPage,
  headers: Headers,
): Locale | null {
  if (headers.get(STATUS_LOCALE_HEADER)) return null
  const offered = offeredLocales(page)
  if (offered.length < 2) return null
  const preferred = visitorLocale(offered, headers)
  return preferred && preferred !== pageDefaultLocale(page) ? preferred : null
}

/**
 * `path` (as the visitor sees it, e.g. `/status/acme/events?month=2026-10` or `/events` on a
 * custom domain) in `locale`: the locale prefix after `basePath` is replaced or removed.
 */
export function localizedPath(
  page: LocalizedPage,
  basePath: string,
  path: string,
  locale: Locale,
): string {
  const queryAt = path.indexOf('?')
  const pathname = queryAt >= 0 ? path.slice(0, queryAt) : path
  const search = queryAt >= 0 ? path.slice(queryAt) : ''
  const below = pathname.startsWith(basePath) ? pathname.slice(basePath.length) : ''
  const { rest } = splitLocalePrefix(below)
  const target = `${basePath}${localePrefix(page, locale)}${rest === '/' ? '' : rest}`
  return `${target || '/'}${search}`
}

/** The status page fields that decide its time zone. */
export interface ZonedPage {
  timeZoneMode?: string | null
}

/** Whether timestamps follow the visitor's browser (the default) or stay in the page's zone. */
export const followsVisitorTimeZone = (page: ZonedPage | null | undefined): boolean =>
  page?.timeZoneMode !== 'page'
