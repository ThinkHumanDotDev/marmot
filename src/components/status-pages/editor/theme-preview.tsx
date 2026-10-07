'use client'

import { useTranslations } from 'next-intl'
import * as React from 'react'

import { BeatBar, type BeatBarBeat } from '@/components/status-pages/beat-bar'
import {
  IncidentCard,
  OverallBanner,
  StatusPageLogo,
} from '@/components/status-pages/public/status-page-view'
import { StatusDot } from '@/components/status-dot'
import {
  resolveThemeColors,
  resolveThemeRadius,
  themeVariables,
  type ThemeMode,
  type ThemeOverrides,
} from '@/lib/status-page-themes'
import { cn } from '@/lib/utils'
import type { PublicIncident } from '@/server/status-pages/public'

/** Fixed sample beats so the preview renders identically on server and client. */
function sampleBeats(pattern: string): BeatBarBeat[] {
  const start = Date.UTC(2026, 0, 1)
  const status: Record<string, BeatBarBeat['status']> = {
    u: 'up',
    d: 'down',
    p: 'pending',
    m: 'maintenance',
  }
  return pattern.split('').map((c, i) => ({
    status: status[c] ?? 'up',
    time: new Date(start + i * 60_000).toISOString(),
    ping: 40,
  }))
}

const BEATS = {
  website: sampleBeats('uuuuuuuuuuuuuuuuuuuuuuuuuuuu'),
  api: sampleBeats('uuuuuuuuuuuuuuuuuuuuuupddduu'),
  database: sampleBeats('uuuuuuuuuuuuummmmuuuuuuuuuu'),
}

export interface ThemePreviewProps {
  title: string
  presetId: string
  overrides: ThemeOverrides
  mode: ThemeMode
  bannerText: string
  logo: string | null
  logoDark: string | null
}

/**
 * A miniature public status page rendered with the unsaved theme: the resolved tokens are set as
 * CSS variables on the wrapper (and `dark` toggles the dark variants), so it shows exactly the
 * variables the public page will get.
 */
export function ThemePreview({
  title,
  presetId,
  overrides,
  mode,
  bannerText,
  logo,
  logoDark,
}: ThemePreviewProps) {
  const t = useTranslations('statusPages.theme.preview')
  const style = React.useMemo(
    () =>
      themeVariables(
        resolveThemeColors(presetId, overrides, mode),
        resolveThemeRadius(presetId, overrides),
      ) as React.CSSProperties,
    [presetId, overrides, mode],
  )

  const incident: PublicIncident = {
    id: 'preview',
    title: t('sampleIncident'),
    content: t('sampleIncidentBody'),
    style: 'warning',
    pinned: true,
    active: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    resolvedAt: null,
  }

  const monitors = [
    { key: 'website' as const, status: 'up' as const, beats: BEATS.website },
    { key: 'api' as const, status: 'down' as const, beats: BEATS.api },
    { key: 'database' as const, status: 'maintenance' as const, beats: BEATS.database },
  ]

  return (
    <div
      data-theme-preview={mode}
      className={cn(
        'overflow-hidden rounded-xl border bg-background text-foreground',
        mode === 'dark' && 'dark',
      )}
      style={{ ...style, colorScheme: mode }}
    >
      <div className="flex flex-col gap-4 p-4 text-sm" inert>
        <header className="flex items-center gap-3">
          {mode === 'dark' ? (
            <StatusPageLogo config={{ logo: logoDark ?? logo, logoDark: null }} />
          ) : (
            <StatusPageLogo config={{ logo: logo ?? logoDark, logoDark: null }} />
          )}
          <p className="truncate text-lg font-semibold tracking-tight">{title}</p>
        </header>
        <OverallBanner status="partial" text={bannerText.trim() || null} />
        <IncidentCard incident={incident} />
        <div className="rounded-xl border bg-card px-4 py-3 shadow-sm">
          <p className="text-sm font-semibold tracking-tight">{t('sampleGroup')}</p>
          <ul className="divide-y">
            {monitors.map((m) => (
              <li key={m.key} className="flex items-center gap-3 py-2">
                <StatusDot status={m.status} />
                <span className="w-20 shrink-0 truncate font-medium">
                  {t(`sampleMonitors.${m.key}`)}
                </span>
                <BeatBar beats={m.beats} size={28} className="min-w-0 flex-1" />
              </li>
            ))}
          </ul>
        </div>
        <div className="flex items-center gap-2" aria-hidden>
          {(['chart1', 'chart2', 'chart3', 'chart4', 'chart5'] as const).map((token, i) => (
            <span
              key={token}
              className="h-6 flex-1 rounded-md"
              style={{ background: `var(--chart-${i + 1})` }}
            />
          ))}
          <span className="rounded-md bg-primary px-2 py-1 text-xs font-medium text-primary-foreground">
            Aa
          </span>
          <span className="rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground">Aa</span>
        </div>
      </div>
    </div>
  )
}
