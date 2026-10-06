import { getRequestConfig } from 'next-intl/server'

import { DEFAULT_TIME_ZONE, formats } from '@/i18n/formats'
import { isLocale } from '@/i18n/locales'
import { getMessages } from '@/i18n/messages'
import { getRequestLocale } from '@/i18n/server'

/**
 * next-intl request configuration ("without i18n routing": URLs carry no locale prefix).
 * `locale` is set when a caller passes one explicitly (`getTranslations({ locale })`, used by the
 * public status pages, which have their own language setting); otherwise the locale is resolved
 * from the signed-in user, the `marmot-locale` cookie and `Accept-Language` (`src/i18n/server.ts`).
 */
export default getRequestConfig(async ({ locale: override }) => {
  const locale = isLocale(override) ? override : await getRequestLocale()
  return {
    locale,
    messages: getMessages(locale),
    formats,
    timeZone: DEFAULT_TIME_ZONE,
  }
})
