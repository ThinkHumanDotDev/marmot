import { cn } from '@/lib/utils'
import type { MonitorStatusKey } from '@/stores/monitor-store'

const colour: Record<MonitorStatusKey, string> = {
  up: 'bg-status-up',
  down: 'bg-status-down',
  pending: 'bg-status-pending',
  maintenance: 'bg-status-maintenance',
  unknown: 'bg-muted-foreground/40',
}

export const statusLabel: Record<MonitorStatusKey, string> = {
  up: 'Up',
  down: 'Down',
  pending: 'Pending',
  maintenance: 'Maintenance',
  unknown: 'Unknown',
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
  return (
    <span
      role="img"
      aria-label={statusLabel[status]}
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
