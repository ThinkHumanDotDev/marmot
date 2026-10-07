import { useTranslations } from 'next-intl'

import { cn } from '@/lib/utils'
import type { MonitorStatusKey } from '@/stores/monitor-store'

const colour: Record<MonitorStatusKey, string> = {
  up: 'bg-status-up',
  down: 'bg-status-down',
  pending: 'bg-status-pending',
  maintenance: 'bg-status-maintenance',
  unknown: 'bg-muted-foreground/40',
}

const STATUS_ORDER = ['up', 'down', 'pending', 'maintenance', 'unknown'] as const

/**
 * Screen-reader summary for a row of heartbeat bars, e.g.
 * "Last 50 checks: 48 up, 2 down. Latest: Up." Colour alone never carries the status.
 * Returns the summariser so it can be called per row (works in server and client components).
 */
export function useDescribeBeats(): (statuses: readonly MonitorStatusKey[]) => string {
  const t = useTranslations('common.beats')
  const tStatus = useTranslations('common.status')
  return (statuses) => {
    if (statuses.length === 0) return t('none')
    const counts = new Map<MonitorStatusKey, number>()
    for (const s of statuses) counts.set(s, (counts.get(s) ?? 0) + 1)
    const parts = STATUS_ORDER.filter((key) => counts.has(key)).map((key) =>
      t('count', { count: counts.get(key) ?? 0, status: t(`status.${key}`) }),
    )
    return t('summary', {
      count: statuses.length,
      parts: parts.join(', '),
      latest: tStatus(statuses[statuses.length - 1]),
    })
  }
}

/** Small coloured circle for monitor state; pulses while something is down. */
export function StatusDot({
  status,
  className,
  pulse = status === 'down',
}: {
  status: MonitorStatusKey
  className?: string
  pulse?: boolean
}) {
  const t = useTranslations('common.status')
  return (
    <span
      role="img"
      aria-label={t(status)}
      className={cn(
        'relative inline-flex size-2.5 shrink-0 rounded-full',
        colour[status],
        className,
      )}
    >
      {pulse && (
        <span
          aria-hidden
          className={cn('absolute inset-0 animate-ping rounded-full opacity-60', colour[status])}
        />
      )}
    </span>
  )
}
