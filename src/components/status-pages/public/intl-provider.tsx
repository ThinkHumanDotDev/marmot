'use client'

import { NextIntlClientProvider, type AbstractIntlMessages } from 'next-intl'
import * as React from 'react'

import { formats } from '@/i18n/formats'
import type { Locale } from '@/i18n/locales'

import { useEffectiveTimeZone } from './visitor-time-zone'

/** A language of the page with the URL of the current view in it. */
export interface LocaleAlternate {
  locale: Locale
  /** The language's name in itself (`Français`). */
  name: string
  /** The current path in that language (`/status/acme/fr/events`). */
  href: string
}

interface StatusPageI18n {
  locale: Locale
  /** The page's languages, default first; a single entry hides the switcher. */
  alternates: LocaleAlternate[]
  /** Zone the server renders in (`statusPageTimeZone`). */
  pageTimeZone: string
  /** Times follow the visitor's browser unless the page has a fixed zone. */
  followVisitor: boolean
}

const StatusPageI18nContext = React.createContext<StatusPageI18n | null>(null)

/** Languages and time zone settings of the page (null outside a public status page). */
export const useStatusPageI18n = () => React.useContext(StatusPageI18nContext)

/**
 * next-intl provider of the public status pages: the page language, its catalogue and the
 * effective time zone (`useEffectiveTimeZone`), which switches from the page zone to the visitor's
 * after hydration, so every `useFormatter()` below formats in it without a hydration mismatch.
 */
export function StatusPageIntlProvider({
  locale,
  messages,
  alternates,
  pageTimeZone,
  followVisitor,
  children,
}: StatusPageI18n & { messages: AbstractIntlMessages; children: React.ReactNode }) {
  const timeZone = useEffectiveTimeZone(pageTimeZone, followVisitor)
  const value = React.useMemo(
    () => ({ locale, alternates, pageTimeZone, followVisitor }),
    [locale, alternates, pageTimeZone, followVisitor],
  )
  return (
    <StatusPageI18nContext.Provider value={value}>
      <NextIntlClientProvider
        locale={locale}
        messages={messages}
        formats={formats}
        timeZone={timeZone}
      >
        {children}
      </NextIntlClientProvider>
    </StatusPageI18nContext.Provider>
  )
}
