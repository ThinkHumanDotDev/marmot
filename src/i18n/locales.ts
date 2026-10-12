/**
 * The single source of truth for the languages Marmot speaks. Adding a language means adding its
 * catalogue under `src/i18n/messages/<locale>.json`, registering it in `src/i18n/messages/index.ts`
 * and appending it here; nothing else in the code base lists locales.
 *
 * `locales` is every language with a catalogue. Some catalogues only cover the public status page
 * surfaces (`PUBLIC_MESSAGE_SCOPES` in `src/i18n/messages/scopes.ts`): visitors can read a status
 * page, its feeds and the subscriber emails in them, but the signed-in app only offers the
 * languages in `appLocales`, whose catalogues are complete.
 *
 * This module is imported by client components, collections and the worker alike, so it must stay
 * free of Next.js and Payload imports.
 */
export const locales = ['en', 'fr', 'de', 'es'] as const

export type Locale = (typeof locales)[number]

/** Languages with a complete catalogue: the signed-in app, organization and admin languages. */
export const appLocales = ['en'] as const satisfies readonly Locale[]

export type AppLocale = (typeof appLocales)[number]

export const defaultLocale: AppLocale = 'en'

/** Each language's name in its own language, for the language pickers. */
export const localeNames: Record<Locale, string> = {
  en: 'English',
  fr: 'Français',
  de: 'Deutsch',
  es: 'Español',
}

/** Cookie that remembers the language on signed-out pages (login, invite, status pages). */
export const LOCALE_COOKIE = 'marmot-locale'

/** One year: the preference also lives on the user record, the cookie is a convenience. */
export const LOCALE_COOKIE_MAX_AGE = 365 * 24 * 60 * 60

/** Whether the app UI should offer a language picker at all (`appLocales`). */
export const hasMultipleLocales = (): boolean => (appLocales as readonly string[]).length > 1

export function isLocale(value: unknown, supported: readonly string[] = locales): value is Locale {
  return typeof value === 'string' && supported.includes(value)
}

/**
 * Language tags of an `Accept-Language` header in order of preference (highest `q` first,
 * header order for equal weights). `*` and `q=0` entries are dropped.
 */
export function parseAcceptLanguage(header: string | null | undefined): string[] {
  if (!header) return []
  const entries = header
    .split(',')
    .map((part, index) => {
      const [tag, ...params] = part.trim().split(';')
      let quality = 1
      for (const param of params) {
        const [key, value] = param.trim().split('=')
        if (key === 'q') {
          const parsed = Number(value)
          quality = Number.isFinite(parsed) ? parsed : 0
        }
      }
      return { tag: tag.trim(), quality, index }
    })
    .filter((entry) => entry.tag !== '' && entry.tag !== '*' && entry.quality > 0)
  entries.sort((a, b) => b.quality - a.quality || a.index - b.index)
  return entries.map((entry) => entry.tag)
}

/**
 * The first supported locale that matches one of `tags`, trying an exact match before a match on
 * the base language (`en-GB` → `en`, `pt` → `pt-BR`). Comparison ignores case.
 */
export function matchLocale(
  tags: readonly string[],
  supported: readonly string[] = locales,
): Locale | undefined {
  const base = (tag: string) => tag.toLowerCase().split('-')[0]
  for (const raw of tags) {
    const tag = raw.toLowerCase()
    const exact = supported.find((locale) => locale.toLowerCase() === tag)
    if (exact) return exact as Locale
    const byBase = supported.find((locale) => base(locale) === base(tag))
    if (byBase) return byBase as Locale
  }
  return undefined
}

export interface LocaleSources {
  /** `users.language` of the signed-in user, or a status page's fixed language. */
  preference?: string | null
  /** Value of the `marmot-locale` cookie. */
  cookie?: string | null
  /** The `Accept-Language` request header. */
  acceptLanguage?: string | null
}

/**
 * Resolves the locale of a request: saved preference, then cookie, then `Accept-Language`
 * (matched by base language), then `defaultLocale`. Unknown values at any step are skipped
 * rather than trusted, so a stale cookie from a removed language falls through.
 */
export function resolveLocale(
  sources: LocaleSources,
  supported: readonly string[] = appLocales,
): Locale {
  if (isLocale(sources.preference, supported)) return sources.preference
  if (isLocale(sources.cookie, supported)) return sources.cookie
  const fromHeader = matchLocale(parseAcceptLanguage(sources.acceptLanguage), supported)
  if (fromHeader) return fromHeader
  return isLocale(defaultLocale, supported) ? defaultLocale : (supported[0] as Locale)
}

/** Value of one cookie in a `Cookie` request header, or `undefined`. */
export function readCookie(header: string | null | undefined, name: string): string | undefined {
  if (!header) return undefined
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=')
    if (key === name) {
      try {
        return decodeURIComponent(rest.join('='))
      } catch {
        return rest.join('=')
      }
    }
  }
  return undefined
}
