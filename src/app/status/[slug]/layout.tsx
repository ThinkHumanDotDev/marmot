import type { Viewport } from 'next'
import { Inter } from 'next/font/google'
import { headers as getHeaders } from 'next/headers'
import { redirect } from 'next/navigation'
import React from 'react'

import '@/app/(frontend)/styles.css'

import { StatusPageIntlProvider } from '@/components/status-pages/public/intl-provider'
import { visitorThemeScript } from '@/components/status-pages/public/theme-storage'
import { localeNames } from '@/i18n/locales'
import { getMessages } from '@/i18n/messages'
import { getStatusPageLocale, statusPageTimeZone } from '@/i18n/server'
import {
  followsVisitorTimeZone,
  localizedPath,
  offeredLocales,
  preferredLocaleRedirect,
  STATUS_PATH_HEADER,
} from '@/lib/status-page-locales'
import { buildThemeCss } from '@/lib/status-page-themes'
import { statusPageBasePath, statusPageRootPath } from '@/server/status-pages/urls'

import { loadPublishedPage } from './data'

export const dynamic = 'force-dynamic'

const inter = Inter({ subsets: ['latin'], display: 'swap', variable: '--font-inter' })

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f7f5f1' },
    { media: '(prefers-color-scheme: dark)', color: '#1c1a18' },
  ],
}

/**
 * Root layout of the public status pages (`/status/[slug]`). It lives outside `(frontend)` so
 * visitors never load the app shell, auth or realtime code. The page's `theme` decides the
 * `dark` class: `auto` applies the visitor's choice from the theme toggle (localStorage) or else
 * their system preference through a tiny inline script, `light`/`dark` are fixed. The theme preset
 * and colour overrides are rendered as CSS variables (`buildThemeCss`, validated values only).
 *
 * Languages (#114): the URL's language prefix decides the locale (`src/proxy.ts` strips it), the
 * plain URL shows the page's `defaultLocale`. On a plain URL, a visitor who picked another offered
 * language in the footer switcher, or whose browser prefers one, is redirected to it. Timestamps
 * render in the page's time zone on the server and switch to the visitor's after hydration unless
 * the page has a fixed zone (`StatusPageIntlProvider`). The layout never 404s itself; the page
 * does, so `not-found.tsx` renders inside this document.
 */
export default async function StatusLayout({
  children,
  params,
}: {
  children: React.ReactNode
  params: Promise<{ slug: string }>
}) {
  const { slug } = await params
  const page = await loadPublishedPage(slug)
  const headers = await getHeaders()
  const visitorPath = headers.get(STATUS_PATH_HEADER)
  if (page && visitorPath) {
    const preferred = preferredLocaleRedirect(page, headers)
    if (preferred) {
      redirect(localizedPath(page, statusPageRootPath(page, headers), visitorPath, preferred))
    }
  }
  const theme = page?.theme ?? 'auto'
  const themeCss = page ? buildThemeCss(page.themePreset, page.themeOverrides) : ''
  const locale = await getStatusPageLocale(page)
  const timeZone = statusPageTimeZone(page)
  const root = page ? statusPageRootPath(page, headers) : ''
  const current = visitorPath ?? (page ? statusPageBasePath(page, headers) : '')
  const alternates = page
    ? offeredLocales(page).map((offered) => ({
        locale: offered,
        name: localeNames[offered],
        href: localizedPath(page, root, current, offered),
      }))
    : []

  return (
    <html
      lang={locale}
      suppressHydrationWarning
      className={`${inter.variable}${theme === 'dark' ? ' dark' : ''}`}
      data-theme={theme}
    >
      <head>
        {theme === 'auto' && (
          <script
            // Applied before paint so an `auto` page never flashes the wrong theme.
            dangerouslySetInnerHTML={{
              __html: visitorThemeScript,
            }}
          />
        )}
        {themeCss && (
          // Only known CSS variables with grammar-checked colour values (src/lib/status-page-themes).
          <style data-theme-tokens dangerouslySetInnerHTML={{ __html: themeCss }} />
        )}
      </head>
      <body className="min-h-dvh bg-background text-foreground antialiased">
        <StatusPageIntlProvider
          locale={locale}
          messages={getMessages(locale)}
          alternates={alternates}
          pageTimeZone={timeZone}
          followVisitor={followsVisitorTimeZone(page)}
        >
          {children}
        </StatusPageIntlProvider>
      </body>
    </html>
  )
}
