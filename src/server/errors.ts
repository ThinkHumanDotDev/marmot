import { APIError } from 'payload'

import { defaultLocale, type Locale } from '@/i18n/locales'
import type { Messages } from '@/i18n/messages'
import { serverTranslator } from '@/server/i18n'

/**
 * API errors whose human message is a catalogue entry (`errors.*` in `src/i18n/messages/en.json`).
 *
 * `apiError('memberNotFound', 404)` is an `APIError` whose `message` is the English text, so every
 * existing catch site (Payload REST, logs, tests) keeps working unchanged. Marmot's route handlers
 * (`withErrors` in `src/server/http.ts`) re-render it in the request's locale. The key itself is the
 * stable identifier and is never translated.
 *
 * Kept free of `@payload-config` so collections and server modules can import it without a cycle.
 */

export type ErrorKey = keyof Messages['errors']
export type ErrorValues = Record<string, string | number>

/** The `errors.<key>` message in `locale`. */
export function translateError(locale: Locale, key: ErrorKey, values?: ErrorValues): string {
  // The key is a runtime value here, so the per-key argument types cannot be checked.
  const t = serverTranslator(locale) as unknown as (key: string, values?: ErrorValues) => string
  return t(`errors.${key}`, values)
}

export interface ApiErrorOptions {
  /** Structured details (`APIError.data`), e.g. `{ code, limit }` for clients. */
  data?: Record<string, unknown>
  /** Show the message to users in production (Payload hides non-public 5xx messages). */
  isPublic?: boolean
}

export class LocalizedAPIError extends APIError {
  readonly key: ErrorKey
  readonly values?: ErrorValues

  constructor(key: ErrorKey, status: number, values?: ErrorValues, options: ApiErrorOptions = {}) {
    super(translateError(defaultLocale, key, values), status, options.data, options.isPublic)
    this.key = key
    this.values = values
  }

  /** The message in another locale. */
  messageIn(locale: Locale): string {
    return translateError(locale, this.key, this.values)
  }
}

/** `throw apiError('invalidRole', 400)`: an `APIError` with a translatable message. */
export const apiError = (
  key: ErrorKey,
  status: number,
  values?: ErrorValues,
  options?: ApiErrorOptions,
) => new LocalizedAPIError(key, status, values, options)
