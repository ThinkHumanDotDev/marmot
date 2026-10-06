import { getFormatter, getTranslations } from 'next-intl/server'

import { cn } from '@/lib/utils'

type PreviewStatus = 'up' | 'down' | 'pending'

const fill: Record<PreviewStatus, string> = {
  up: 'bg-status-up',
  down: 'bg-status-down',
  pending: 'bg-status-pending',
}

/** Deterministic beat history: mostly up, with the incidents placed at fixed positions. */
function beats(length: number, incidents: Partial<Record<number, PreviewStatus>>): PreviewStatus[] {
  return Array.from({ length }, (_, i) => incidents[i] ?? 'up')
}

/** Example monitors; names come from `landing.preview.monitors.<key>`, `target: null` = push. */
const MONITORS = [
  { key: 'marketingSite', target: 'https://example.com', uptime: 1, beats: beats(28, {}) },
  {
    key: 'publicApi',
    target: 'api.example.com:443',
    uptime: 0.9994,
    beats: beats(28, { 17: 'down', 18: 'pending' }),
  },
  {
    key: 'postgresPrimary',
    target: 'db.internal:5432',
    uptime: 0.9999,
    beats: beats(28, { 9: 'pending' }),
  },
  { key: 'nightlyBackup', target: null, uptime: 1, beats: beats(28, {}) },
] as const

/**
 * Static, decorative mock of the monitor list for the landing page hero. Hidden from assistive
 * technology: it shows example data, not the visitor's monitors.
 */
export async function MonitorPreview() {
  const [t, format] = await Promise.all([getTranslations('landing.preview'), getFormatter()])
  return (
    <div aria-hidden className="rounded-2xl border bg-background p-2 shadow-lg shadow-foreground/5">
      <div className="flex items-center justify-between px-3 pt-2 pb-3">
        <span className="text-sm font-semibold">{t('title')}</span>
        <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className="size-1.5 rounded-full bg-status-up" /> {t('live')}
        </span>
      </div>
      <ul className="divide-y rounded-xl border bg-card">
        {MONITORS.map((monitor) => (
          <li key={monitor.key} className="flex items-center gap-3 px-3 py-3">
            <span
              className={cn(
                'size-2 shrink-0 rounded-full',
                monitor.beats.at(-1) === 'up' ? 'bg-status-up' : 'bg-status-down',
              )}
            />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">
                {t(`monitors.${monitor.key}`)}
              </span>
              <span className="block truncate text-xs text-muted-foreground">
                {monitor.target ?? t('pushHeartbeat')}
              </span>
            </span>
            <span className="hidden h-6 items-stretch gap-[2px] sm:flex">
              {monitor.beats.map((status, i) => (
                <span key={i} className={cn('w-[3px] rounded-full', fill[status])} />
              ))}
            </span>
            <span className="w-14 text-right text-xs font-medium tabular-nums">
              {monitor.uptime === 1
                ? format.number(1, 'wholePercent')
                : format.number(monitor.uptime, 'percent')}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}
