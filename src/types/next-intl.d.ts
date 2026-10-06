import type { AppFormats } from '@/i18n/formats'
import type { Locale } from '@/i18n/locales'
import type { Messages } from '@/i18n/messages'

/**
 * Makes `useTranslations` / `getTranslations` keys, `locale` values and named formats type-safe:
 * a missing or misspelt key in `src/i18n/messages/en.json` fails `pnpm typecheck`.
 */
declare module 'next-intl' {
  interface AppConfig {
    Locale: Locale
    Messages: Messages
    Formats: AppFormats
  }
}
