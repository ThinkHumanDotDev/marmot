import type { Viewport } from 'next'
import { Inter } from 'next/font/google'
import { NextIntlClientProvider } from 'next-intl'
import React from 'react'

import '@/app/(frontend)/styles.css'

import { visitorThemeScript } from '@/components/status-pages/public/theme-storage'
import { formats } from '@/i18n/formats'
import { getMessages } from '@/i18n/messages'
import { getStatusPageLocale, statusPageTimeZone } from '@/i18n/server'
import { buildThemeCss } from '@/lib/status-page-themes'

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
 * and colour overrides are rendered as CSS variables (`buildThemeCss`, validated values only). The page's `language` decides the locale (`auto` follows the
 * visitor's browser); timestamps render in the organization's time zone so the server HTML and
 * the client agree. The layout never 404s itself; the page does, so `not-found.tsx` renders
 * inside this document.
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
  const theme = page?.theme ?? 'auto'
  const themeCss = page ? buildThemeCss(page.themePreset, page.themeOverrides) : ''
  const locale = await getStatusPageLocale(page)
  const timeZone = statusPageTimeZone(page)

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
        <NextIntlClientProvider
          locale={locale}
          messages={getMessages(locale)}
          formats={formats}
          timeZone={timeZone}
        >
          {children}
        </NextIntlClientProvider>
      </body>
    </html>
  )
}
