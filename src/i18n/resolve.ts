import { timeZoneOrDefault } from '@/i18n/formats'
import { LOCALE_COOKIE, locales, readCookie, resolveLocale, type Locale } from '@/i18n/locales'
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
  supported: readonly string[] = locales,
): Locale {
  return resolveLocale(
    {
      preference: user?.language ?? null,
      cookie: readCookie(headers.get('cookie'), LOCALE_COOKIE) ?? null,
      acceptLanguage: headers.get('accept-language'),
    },
    supported,
  )
}

/**
 * Locale of a public status page: the page's own `language`, or, when it is set to follow the
 * visitor (`auto`), the visitor's cookie and `Accept-Language`. Pages that do not exist (404)
 * follow the visitor too. Never consults the signed-in user: the page is public.
 */
export function resolveStatusPageLocale(
  page: Pick<StatusPage, 'language'> | null | undefined,
  headers: Headers,
): Locale {
  const fixed = page?.language && page.language !== 'auto' ? page.language : null
  return resolveLocale({
    preference: fixed,
    cookie: readCookie(headers.get('cookie'), LOCALE_COOKIE) ?? null,
    acceptLanguage: headers.get('accept-language'),
  })
}

/**
 * Time zone timestamps on a public status page are rendered in: the organization's
 * `settings.timezone` (the page is loaded with `depth: 1`, so the organization is populated), or
 * UTC. Explicit so the server render and the client hydration agree whatever the visitor's zone.
 */
export function statusPageTimeZone(
  page: Pick<StatusPage, 'organization'> | null | undefined,
): string {
  const org = page?.organization
  const zone = org && typeof org === 'object' ? org.settings?.timezone : null
  return timeZoneOrDefault(zone)
}
