import type { Locale } from '@/i18n/locales'

import en from './en.json'

/**
 * Message catalogues by locale. English is the reference catalogue: its shape types every `t()`
 * call (`src/types/next-intl.d.ts`), and `tests/int/i18n.int.spec.ts` checks that every other
 * catalogue has exactly the same keys. The map is spelled out (no computed `import()`) so the
 * worker bundle (`pnpm build:server`) can include it; `satisfies Record<Locale, …>` makes the
 * typecheck fail until a locale added to `src/i18n/locales.ts` has its catalogue registered here.
 */
export const messages = { en } satisfies Record<Locale, typeof en>

export type Messages = typeof en

export function getMessages(locale: Locale): Messages {
  return messages[locale]
}
