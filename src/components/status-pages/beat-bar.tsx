import { describeBeats } from '@/components/status-dot'
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

function beatTitle(beat: BeatBarBeat): string {
  const when = new Date(beat.time)
  const time = Number.isNaN(when.getTime()) ? beat.time : when.toLocaleString()
  const ping = typeof beat.ping === 'number' ? ` · ${Math.round(beat.ping)} ms` : ''
  return `${beat.status.toUpperCase()} · ${time}${ping}`
}

/**
 * Row of up to `size` heartbeat bars, oldest left, newest right. Missing beats render as empty
 * slots so the bar keeps a constant width (Uptime Kuma `HeartbeatBar`).
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
  const shown = beats.slice(-size)
  const padding = Math.max(0, size - shown.length)

  return (
    <div
      className={cn('flex h-6 items-center gap-px', className)}
      role="img"
      aria-label={describeBeats(shown.map((beat) => beat.status))}
    >
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
