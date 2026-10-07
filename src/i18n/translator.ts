import { createFormatter, createTranslator } from 'next-intl'

import { DEFAULT_TIME_ZONE, formats } from '@/i18n/formats'
import { defaultLocale, isLocale, type Locale } from '@/i18n/locales'
import { getMessages } from '@/i18n/messages'

/**
 * Translator and formatter for code that runs outside a React render: the worker (emails,
 * notification bodies), route handlers (RSS) and tests. React code uses `useTranslations` /
 * `getTranslations` instead, which read the request's locale automatically.
 *
 * Both are safe for the esbuild server bundle (static catalogue map, no `next/headers`).
 */
export function getTranslator(locale: Locale = defaultLocale) {
  return createTranslator({ locale, messages: getMessages(locale), formats })
}

export function getStaticFormatter(locale: Locale = defaultLocale, timeZone = DEFAULT_TIME_ZONE) {
  return createFormatter({ locale, formats, timeZone })
}

/** `value` when it is a supported locale, otherwise `defaultLocale` (for stored preferences). */
export function toLocale(value: unknown): Locale {
  return isLocale(value) ? value : defaultLocale
}
