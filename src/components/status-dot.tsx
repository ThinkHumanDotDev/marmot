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

/**
 * Screen-reader summary for a row of heartbeat bars, e.g.
 * "Last 50 checks: 48 up, 2 down. Latest: Up." Colour alone never carries the status.
 */
export function describeBeats(statuses: readonly MonitorStatusKey[]): string {
  if (statuses.length === 0) return 'No checks yet'
  const counts = new Map<MonitorStatusKey, number>()
  for (const s of statuses) counts.set(s, (counts.get(s) ?? 0) + 1)
  const parts = (['up', 'down', 'pending', 'maintenance', 'unknown'] as const)
    .filter((key) => counts.has(key))
    .map((key) => `${counts.get(key)} ${statusLabel[key].toLowerCase()}`)
  const latest = statusLabel[statuses[statuses.length - 1]]
  const noun = statuses.length === 1 ? 'check' : 'checks'
  return `Last ${statuses.length} ${noun}: ${parts.join(', ')}. Latest: ${latest}.`
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
