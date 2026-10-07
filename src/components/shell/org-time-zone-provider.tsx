'use client'

import { NextIntlClientProvider, useLocale, useMessages } from 'next-intl'
import type * as React from 'react'

import { formats } from '@/i18n/formats'

/**
 * Renders the organization's pages in its time zone (`organizations.settings.timezone`). Client
 * islands below format dates with `useFormatter()`, which picks the zone up from here, so the
 * server render and the hydration agree whatever the browser's zone is. Locale and messages are
 * taken from the root provider, so the catalogue is not serialised a second time.
 */
export function OrgTimeZoneProvider({
  timeZone,
  children,
}: {
  timeZone: string
  children: React.ReactNode
}) {
  const locale = useLocale()
  const messages = useMessages()
  return (
    <NextIntlClientProvider
      locale={locale}
      messages={messages}
      formats={formats}
      timeZone={timeZone}
    >
      {children}
    </NextIntlClientProvider>
  )
}
