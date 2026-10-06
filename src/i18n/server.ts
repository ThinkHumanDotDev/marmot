import 'server-only'

import { headers as getHeaders } from 'next/headers'
import { cache } from 'react'

import type { Locale } from '@/i18n/locales'
import { resolveRequestLocale, resolveStatusPageLocale } from '@/i18n/resolve'
import { getCurrentUser } from '@/lib/auth'
import type { StatusPage } from '@/payload-types'

export { statusPageTimeZone } from '@/i18n/resolve'

/** The current request's locale, memoised per request. Used by the next-intl request config. */
export const getRequestLocale = cache(async (): Promise<Locale> => {
  const [headers, user] = await Promise.all([getHeaders(), getCurrentUser()])
  return resolveRequestLocale({ headers, user })
})

/** Locale of a public status page for the current request (`resolveStatusPageLocale`). */
export const getStatusPageLocale = cache(
  async (page: Pick<StatusPage, 'language'> | null | undefined): Promise<Locale> =>
    resolveStatusPageLocale(page, await getHeaders()),
)
