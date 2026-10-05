import { describeBeats } from '@/components/status-dot'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

import { formatDateTime, formatPing, type MonitorStatus } from './format'

export interface BeatLike {
  id: string | number
  status: MonitorStatus
  time: string
  ping?: number | null
  msg?: string | null
}

const fill: Record<MonitorStatus, string> = {
  up: 'bg-status-up',
  down: 'bg-status-down',
  pending: 'bg-status-pending',
  maintenance: 'bg-status-maintenance',
}

/**
 * Uptime Kuma's heartbeat bar: one thin rounded bar per beat, oldest left, newest right. Empty
 * slots are drawn as placeholders so the bar keeps its width before 100 beats exist.
 */
export function HeartbeatBar({
  beats,
  size = 100,
  className,
}: {
  /** Newest first (as returned by the heartbeats query). */
  beats: BeatLike[]
  size?: number
  className?: string
}) {
  const shown = beats.slice(0, size).reverse()
  const missing = Math.max(0, size - shown.length)

  return (
    <div
      className={cn('flex h-8 items-center gap-px', className)}
      role="img"
      aria-label={describeBeats(shown.map((beat) => beat.status))}
      data-testid="heartbeat-bar"
    >
      {Array.from({ length: missing }).map((_, i) => (
        <span key={`empty-${i}`} aria-hidden className="h-5 flex-1 rounded-full bg-muted/60" />
      ))}
      {shown.map((beat) => (
        <Tooltip key={beat.id}>
          <TooltipTrigger asChild>
            <span
              className={cn(
                'h-5 flex-1 rounded-full transition-[height] hover:h-7',
                fill[beat.status],
              )}
              data-status={beat.status}
            />
          </TooltipTrigger>
          <TooltipContent side="top" className="text-xs">
            <div className="font-medium capitalize">{beat.status}</div>
            <div>{formatDateTime(beat.time)}</div>
            {beat.ping != null && <div>{formatPing(beat.ping)}</div>}
            {beat.msg && <div className="max-w-64 truncate opacity-80">{beat.msg}</div>}
          </TooltipContent>
        </Tooltip>
      ))}
    </div>
  )
}
