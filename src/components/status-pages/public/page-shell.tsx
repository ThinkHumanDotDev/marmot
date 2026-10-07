'use client'

import { Rss } from 'lucide-react'
import { useTranslations } from 'next-intl'
import type * as React from 'react'

import { renderMarkdown } from '@/lib/markdown'
import { EVENTS_PATH } from '@/lib/status-page-events'
import type { PublicConfig } from '@/server/status-pages/public'

import { StatusPageLogo } from './parts'
import { ThemeToggle } from './theme-toggle'

/**
 * Header and footer of the status page's sub-pages (history and permalinks): the logo and title
 * link back to the page, the footer links the current status, the history and the feed.
 */
export function StatusPageShell({
  config,
  basePath,
  children,
}: {
  config: PublicConfig
  /** `/status/<slug>`, or `''` on a custom domain. */
  basePath: string
  children: React.ReactNode
}) {
  const t = useTranslations('statusPages')
  const home = basePath || '/'
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-4 py-10 sm:px-6">
      <header className="flex items-center gap-4">
        {(config.logo || config.logoDark) && (
          <a href={home} className="shrink-0" aria-label={t('events.backToStatus')}>
            <StatusPageLogo config={config} className="size-10" />
          </a>
        )}
        <p className="min-w-0 flex-1 text-lg font-semibold tracking-tight">
          <a href={home} className="underline-offset-4 hover:underline" data-status-home>
            {config.title}
          </a>
        </p>
        {config.theme === 'auto' && <ThemeToggle className="shrink-0" />}
      </header>

      {children}

      <footer className="flex flex-col gap-3 border-t pt-6 text-xs text-muted-foreground">
        {config.footerText && (
          <div
            className="[&_a]:underline"
            dangerouslySetInnerHTML={{ __html: renderMarkdown(config.footerText) }}
          />
        )}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="flex items-center gap-3">
            <a href={home} className="hover:text-foreground">
              {t('events.currentStatus')}
            </a>
            <a href={`${basePath}${EVENTS_PATH}`} className="hover:text-foreground">
              {t('events.historyHeading')}
            </a>
          </span>
          <span className="flex items-center gap-3">
            <a
              href={`/status/${encodeURIComponent(config.slug)}/rss`}
              className="inline-flex items-center gap-1 hover:text-foreground"
            >
              <Rss className="size-3.5" aria-hidden /> {t('footer.rss')}
            </a>
            {config.showPoweredBy && (
              <a
                href="https://github.com/ThinkHumanDotDev/marmot"
                target="_blank"
                rel="noopener noreferrer"
                className="hover:text-foreground"
              >
                {t('footer.poweredBy')}
              </a>
            )}
          </span>
        </div>
      </footer>
    </div>
  )
}
