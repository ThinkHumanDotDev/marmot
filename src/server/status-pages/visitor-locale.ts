import { isLocale, type Locale } from '@/i18n/locales'
import { resolveStatusPageLocale } from '@/i18n/resolve'
import type { LocalizedPage } from '@/lib/status-page-locales'

import { headersWithRequestedLocale } from './urls'

/**
 * Language of a visitor's request to a page's API endpoints (`/api/status-pages/:slug/access`,
 * `/subscribe`, …), which the proxy does not see (#271): the `?locale=` the public page sends when
 * the page offers that language, else the page's default language. Without a page (unknown slug,
 * or a request refused before the lookup) any shipped `?locale=` is used, then the visitor's
 * language switcher cookie and `Accept-Language`.
 *
 * Error messages of these endpoints are rendered in it, never in the signed-in app's language.
 */
export function visitorLocale(request: Request, page?: LocalizedPage | null): Locale {
  const headers = headersWithRequestedLocale(request)
  if (page) return resolveStatusPageLocale(page, headers)
  const requested = new URL(request.url).searchParams.get('locale')
  return isLocale(requested) ? requested : resolveStatusPageLocale(null, headers)
}
