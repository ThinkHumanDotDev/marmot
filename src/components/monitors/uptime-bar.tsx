import { useFormatter, useTranslations } from 'next-intl'

import { useDescribeBeats } from '@/components/status-dot'
import { cn } from '@/lib/utils'
import { statusKey, type Heartbeat } from '@/stores/monitor-store'

const barColour: Record<ReturnType<typeof statusKey>, string> = {
  up: 'bg-status-up',
  down: 'bg-status-down',
  pending: 'bg-status-pending',
  maintenance: 'bg-status-maintenance',
  degraded: 'bg-status-degraded',
  unknown: 'bg-muted-foreground/20',
}

export const UPTIME_BAR_BEATS = 50

interface UptimeBarProps {
  /** Oldest → newest; only the newest `count` are drawn, right-aligned like Uptime Kuma. */
  beats: readonly Heartbeat[]
  count?: number
  className?: string
}

/** Row of thin bars, one per recent heartbeat, coloured by status. Empty slots stay muted. */
export function UptimeBar({ beats, count = UPTIME_BAR_BEATS, className }: UptimeBarProps) {
  const describeBeats = useDescribeBeats()
  const tStatus = useTranslations('common.status')
  const tFormat = useTranslations('monitors.format')
  const format = useFormatter()
  const recent = beats.slice(-count)
  const padding = Math.max(0, count - recent.length)

  return (
    <div
      className={cn('flex h-6 items-center gap-px', className)}
      role="img"
      aria-label={describeBeats(recent.map((beat) => statusKey(beat.status)))}
    >
      {Array.from({ length: padding }, (_, i) => (
        <span
          key={`pad-${i}`}
          aria-hidden
          className="h-full flex-1 rounded-[2px] bg-muted-foreground/10"
        />
      ))}
      {recent.map((beat, i) => {
        const key = statusKey(beat.status)
        const parts = [tStatus(key), format.dateTime(new Date(beat.time), 'precise')]
        if (beat.ping != null) parts.push(tFormat('ping', { ms: Math.round(beat.ping) }))
        if (beat.msg) parts.push(beat.msg)
        const title = parts.join(' · ')
        return (
          <span
            key={`${beat.time}-${i}`}
            title={title}
            className={cn('h-full flex-1 rounded-[2px] transition-colors', barColour[key])}
          />
        )
      })}
    </div>
  )
}
