import { createTranslator } from 'next-intl'

import en from '@/i18n/messages/en.json'

/**
 * The CLI's messages (`cli.*` in the English catalogue). The CLI is a standalone program without a
 * request locale, so it renders English like the API's default; the catalogue keeps the wording in
 * one reviewed place with the rest of Marmot's text.
 */
export const t = createTranslator({ locale: 'en', messages: en, namespace: 'cli' })
