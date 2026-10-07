import { defaultLocale, type Locale } from '@/i18n/locales'
import type { Messages } from '@/i18n/messages'
import { serverTranslator } from '@/server/i18n'

export type ImportMessageKey = keyof Messages['importExport']['messages']
export type ImportText = (key: ImportMessageKey, values?: Record<string, string | number>) => string

/**
 * Skip reasons and warnings of an import report in `locale` (`importExport.messages.*`). The
 * planners take it as a parameter so they stay pure; the default renders English, which is what
 * the API answered before the messages moved to the catalogue.
 */
export function importText(locale: Locale = defaultLocale): ImportText {
  const t = serverTranslator(locale) as unknown as (
    key: string,
    values?: Record<string, string | number>,
  ) => string
  return (key, values) => t(`importExport.messages.${key}`, values)
}
