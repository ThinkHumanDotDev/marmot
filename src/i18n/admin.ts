import type { NestedKeysStripped, TFunction } from '@payloadcms/translations'
import { en } from '@payloadcms/translations/languages/en'
import type { Config, LabelFunction } from 'payload'

/**
 * Payload admin panel translations. Payload ships its own UI strings
 * (`@payloadcms/translations`); Marmot's custom labels, descriptions and messages live under the
 * `marmot:` namespace and are referenced as `label: adminT('marmot:language')`, `req.t('marmot:…')`
 * in hooks and `useTranslation()` from `@payloadcms/ui` in admin components. The admin language is
 * separate from the Marmot UI locale (`src/i18n/locales.ts`); a language is only offered here once
 * both Payload and Marmot have a catalogue for it.
 */
export const adminTranslations = {
  en: {
    marmot: {
      language: 'Language',
      userLanguageDescription:
        'Language of the Marmot interface, emails and notifications for this user.',
      organizationLanguageDescription:
        'Default language of notifications and emails sent on behalf of this organization.',
      statusPageLanguageDescription:
        'Language visitors see the page in. "Follow the visitor" uses the browser language.',
      followVisitor: 'Follow the visitor',
    },
  },
}

export type AdminTranslationsObject = typeof adminTranslations.en
export type AdminTranslationKeys = NestedKeysStripped<AdminTranslationsObject>

/** `label` / `description` function for a `marmot:` key, type-checked against the catalogue. */
export const adminT =
  (key: AdminTranslationKeys): LabelFunction =>
  ({ t }) =>
    (t as unknown as TFunction<AdminTranslationKeys>)(key)

export const adminI18n: Config['i18n'] = {
  supportedLanguages: { en },
  fallbackLanguage: 'en',
  translations: adminTranslations,
}
