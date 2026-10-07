import type { Locale } from '@/i18n/locales'
import { resolveRequestLocale } from '@/i18n/resolve'
import { toLocale } from '@/i18n/translator'
import type { User } from '@/payload-types'
import { LocalizedAPIError, translateError, type ErrorKey, type ErrorValues } from '@/server/errors'

/**
 * Locale of an API response. Route handlers remember the user they authenticated
 * (`rememberRequestUser`), so error messages follow the user's `language`; signed-out requests
 * fall back to the `marmot-locale` cookie and `Accept-Language`.
 *
 * Kept free of `@payload-config` so every route helper module can import it.
 */

type LocaleSource = Pick<User, 'language'>

const requestUsers = new WeakMap<Request, LocaleSource>()

/** Records the authenticated user of `request` for `requestLocale`. */
export function rememberRequestUser(request: Request, user: LocaleSource | null | undefined) {
  if (user) requestUsers.set(request, user)
}

/**
 * Locale for a response to `request`: the signed-in user's `language` (once a helper has
 * authenticated the request), then the `marmot-locale` cookie, then `Accept-Language`.
 */
export function requestLocale(request: Request): Locale {
  return resolveRequestLocale({ headers: request.headers, user: requestUsers.get(request) })
}

/**
 * Locale of the user a Local API operation runs as (`req.user` in collection hooks), for
 * validation messages thrown from hooks. Users without a preference get the default.
 */
export function userLocale(user: unknown): Locale {
  return toLocale(
    user && typeof user === 'object' ? (user as { language?: unknown }).language : undefined,
  )
}

/** The `errors.<key>` message for a response to `request` (`jsonError(400, errorText(…))`). */
export const errorText = (request: Request, key: ErrorKey, values?: ErrorValues): string =>
  translateError(requestLocale(request), key, values)

/**
 * Message of a thrown error for a response to `request`: `apiError(…)` errors re-rendered in the
 * request locale, anything else as is (`fallback` for non-`Error` values).
 */
export function errorMessageFor(request: Request, error: unknown, fallback: ErrorKey): string {
  if (error instanceof LocalizedAPIError) return error.messageIn(requestLocale(request))
  return error instanceof Error ? error.message : errorText(request, fallback)
}

/**
 * The `errors.<key>` message for the user a Local API operation runs as (`req.user`), for
 * validation errors thrown from collection hooks. Route handlers call the Local API with the
 * request user, so the message reaches the client in that user's language.
 */
export const userErrorText = (
  req: { user?: unknown } | null | undefined,
  key: ErrorKey,
  values?: ErrorValues,
): string => translateError(userLocale(req?.user), key, values)
