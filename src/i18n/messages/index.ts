import type { AppLocale, Locale } from '@/i18n/locales'

import de from './de.json'
import en from './en.json'
import es from './es.json'
import fr from './fr.json'

/**
 * Message catalogues by locale. English is the reference catalogue: its shape types every `t()`
 * call (`src/types/next-intl.d.ts`), and `tests/int/i18n.int.spec.ts` checks that every other
 * complete catalogue (`appLocales`) has exactly the same keys. The map is spelled out (no computed
 * `import()`) so the worker bundle (`pnpm build:server`) can include it; `satisfies Record<…>`
 * makes the typecheck fail until a locale added to `src/i18n/locales.ts` has its catalogue
 * registered here.
 */
export const messages = { en } satisfies Record<AppLocale, typeof en>

export type Messages = typeof en

/**
 * Catalogues of the languages that only cover the public status page surfaces
 * (`PUBLIC_MESSAGE_SCOPES` in `./scopes.ts`, checked by the same test). They are merged over
 * English, so a key outside those scopes renders in English rather than as its raw key.
 */
export const publicCatalogues = { fr, de, es } satisfies Record<
  Exclude<Locale, AppLocale>,
  object
>

type Tree = { [key: string]: string | Tree }

function deepMerge(base: Tree, override: Tree): Tree {
  const out: Tree = { ...base }
  for (const [key, value] of Object.entries(override)) {
    const current = out[key]
    out[key] =
      typeof value === 'object' && typeof current === 'object' ? deepMerge(current, value) : value
  }
  return out
}

const merged = new Map<Locale, Messages>()

export function getMessages(locale: Locale): Messages {
  if (locale in messages) return messages[locale as AppLocale]
  let catalogue = merged.get(locale)
  if (!catalogue) {
    const partial = publicCatalogues[locale as Exclude<Locale, AppLocale>] as Tree
    catalogue = deepMerge(en as Tree, partial) as Messages
    merged.set(locale, catalogue)
  }
  return catalogue
}
