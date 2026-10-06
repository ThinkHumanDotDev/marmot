import { useFormatter, useTranslations } from 'next-intl'

import { cn } from '@/lib/utils'

export interface BeatBarBeat {
  status: 'up' | 'down' | 'pending' | 'maintenance'
  /** ISO timestamp. */
  time: string
  ping?: number | null
}

const colour: Record<BeatBarBeat['status'], string> = {
  up: 'bg-status-up',
  down: 'bg-status-down',
  pending: 'bg-status-pending',
  maintenance: 'bg-status-maintenance',
}

const STATUS_ORDER = ['up', 'down', 'pending', 'maintenance'] as const

/**
 * Row of up to `size` heartbeat bars, oldest left, newest right. Missing beats render as empty
 * slots so the bar keeps a constant width (Uptime Kuma `HeartbeatBar`). The accessible name
 * summarises the row ("Last 50 checks: 48 up, 2 down. Latest: Up."): colour alone never carries
 * the status.
 */
export function BeatBar({
  beats,
  size = 50,
  className,
}: {
  beats: BeatBarBeat[]
  size?: number
  className?: string
}) {
  const t = useTranslations('statusPages.beats')
  const tStatus = useTranslations('common.status')
  const format = useFormatter()
  const shown = beats.slice(-size)
  const padding = Math.max(0, size - shown.length)

  const beatTitle = (beat: BeatBarBeat): string => {
    const when = new Date(beat.time)
    const time = Number.isNaN(when.getTime()) ? beat.time : format.dateTime(when, 'short')
    const parts = [beat.status.toUpperCase(), time]
    if (typeof beat.ping === 'number') parts.push(t('ping', { ms: Math.round(beat.ping) }))
    return parts.join(' · ')
  }

  let label = t('none')
  if (shown.length > 0) {
    const counts = new Map<BeatBarBeat['status'], number>()
    for (const beat of shown) counts.set(beat.status, (counts.get(beat.status) ?? 0) + 1)
    const parts = STATUS_ORDER.filter((key) => counts.has(key)).map((key) =>
      t('count', { count: counts.get(key) ?? 0, status: t(`status.${key}`) }),
    )
    label = t('summary', {
      count: shown.length,
      parts: parts.join(', '),
      latest: tStatus(shown[shown.length - 1].status),
    })
  }

  return (
    <div className={cn('flex h-6 items-center gap-px', className)} role="img" aria-label={label}>
      {Array.from({ length: padding }, (_, i) => (
        <span
          key={`pad-${i}`}
          aria-hidden
          className="h-full min-w-0 flex-1 rounded-[2px] bg-muted-foreground/15"
        />
      ))}
      {shown.map((beat, i) => (
        <span
          key={`${beat.time}-${i}`}
          title={beatTitle(beat)}
          className={cn(
            'h-full min-w-0 flex-1 rounded-[2px] transition-opacity hover:opacity-70',
            colour[beat.status] ?? 'bg-muted-foreground/30',
          )}
        />
      ))}
    </div>
  )
}
