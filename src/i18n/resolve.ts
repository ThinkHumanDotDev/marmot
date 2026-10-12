import { isValidTimeZone, timeZoneOrDefault } from '@/i18n/formats'
import {
  appLocales,
  LOCALE_COOKIE,
  readCookie,
  resolveLocale,
  type AppLocale,
  type Locale,
} from '@/i18n/locales'
import { statusPageLocaleFor, type LocalizedPage } from '@/lib/status-page-locales'
import type { StatusPage, User } from '@/payload-types'

/**
 * Request-level locale resolution, kept free of `next/headers` so route handlers, the worker and
 * tests can call it with a plain `Headers` object. `src/i18n/server.ts` wraps these for React.
 */

/**
 * Locale of a request to the Marmot UI: the signed-in user's `language`, then the `marmot-locale`
 * cookie, then `Accept-Language`, then the default.
 */
export function resolveRequestLocale(
  { headers, user }: { headers: Headers; user?: Pick<User, 'language'> | null },
  supported: readonly string[] = appLocales,
): AppLocale {
  // `supported` defaults to the app languages; tests pass wider lists to see the order.
  return resolveLocale(
    {
      preference: user?.language ?? null,
      cookie: readCookie(headers.get('cookie'), LOCALE_COOKIE) ?? null,
      acceptLanguage: headers.get('accept-language'),
    },
    supported,
  ) as AppLocale
}

/**
 * Locale of a public status page for a request: the URL's locale prefix when the page offers that
 * language, else the page's `defaultLocale` (`statusPageLocaleFor`). Pages that do not exist (404)
 * follow the visitor's switcher choice and `Accept-Language`. Never consults the signed-in user:
 * the page is public.
 */
export function resolveStatusPageLocale(
  page: LocalizedPage | null | undefined,
  headers: Headers,
): Locale {
  return statusPageLocaleFor(page, headers)
}

/**
 * The page's own time zone: its `timeZone` setting, else the organization's `settings.timezone`
 * (the page is loaded with `depth: 1`, so the organization is populated), else UTC. The server
 * renders every timestamp in it so the HTML and the client hydration agree; pages that follow the
 * visitor's zone switch after hydration (`StatusPageIntlProvider`).
 */
export function statusPageTimeZone(
  page: Pick<StatusPage, 'organization' | 'timeZone'> | null | undefined,
): string {
  if (isValidTimeZone(page?.timeZone)) return page.timeZone
  const org = page?.organization
  const zone = org && typeof org === 'object' ? org.settings?.timezone : null
  return timeZoneOrDefault(zone)
}
