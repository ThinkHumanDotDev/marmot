import type { Metadata, Viewport } from 'next'
import { Inter } from 'next/font/google'
import React from 'react'

import { ConsentManager } from '@/components/consent/consent-manager'
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

export const metadata: Metadata = {
  title: { default: 'Marmot', template: '%s · Marmot' },
  description: 'Self-hosted status monitor for teams.',
  applicationName: 'Marmot',
}

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f7f5f1' },
    { media: '(prefers-color-scheme: dark)', color: '#1c1a18' },
  ],
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  // Opt-in analytics (docs/Telemetry.md): the consent banner and the PostHog bridge exist only
  // when the operator set NEXT_PUBLIC_POSTHOG_KEY; otherwise nothing analytics-related is mounted.
  const analytics = isAnalyticsEnabled()
  return (
    <html lang="en" suppressHydrationWarning className={inter.variable}>
      <body className="min-h-dvh bg-background text-foreground antialiased">
        <ThemeProvider>
          <TooltipProvider delayDuration={200}>{children}</TooltipProvider>
          <Toaster position="bottom-right" richColors closeButton />
          {analytics && <ConsentManager />}
        </ThemeProvider>
      </body>
    </html>
  )
}
