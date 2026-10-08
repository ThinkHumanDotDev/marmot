import type { Metadata, Viewport } from 'next'
import { Inter } from 'next/font/google'
import { NextIntlClientProvider } from 'next-intl'
import { getLocale, getTranslations } from 'next-intl/server'
import React from 'react'

import { ConsentManager } from '@/components/consent/consent-manager'
import { DemoBannerSlot } from '@/components/demo/demo-banner-slot'
import { ThemeProvider } from '@/components/theme-provider'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { isAnalyticsEnabled } from '@/lib/analytics-config'

import './styles.css'

const inter = Inter({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-inter',
})

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('metadata')
  return {
    title: { default: 'Marmot', template: '%s · Marmot' },
    description: t('description'),
    applicationName: 'Marmot',
  }
}

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f7f5f1' },
    { media: '(prefers-color-scheme: dark)', color: '#1c1a18' },
  ],
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // User preference → `marmot-locale` cookie → Accept-Language → default (src/i18n/server.ts).
  const locale = await getLocale()
  // Opt-in analytics (docs/Telemetry.md): the consent banner and the PostHog bridge exist only
  // when the operator set NEXT_PUBLIC_POSTHOG_KEY; otherwise nothing analytics-related is mounted.
  const analytics = isAnalyticsEnabled()
  return (
    <html lang={locale} suppressHydrationWarning className={inter.variable}>
      <body className="min-h-dvh bg-background text-foreground antialiased">
        {/* Inherits locale, messages, formats and time zone from the request config. */}
        <NextIntlClientProvider>
          <ThemeProvider>
            {/* Demo mode (#159) only: renders nothing otherwise. */}
            <DemoBannerSlot />
            <TooltipProvider delayDuration={200}>{children}</TooltipProvider>
            <Toaster position="bottom-right" richColors closeButton />
            {analytics && <ConsentManager />}
          </ThemeProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  )
}
