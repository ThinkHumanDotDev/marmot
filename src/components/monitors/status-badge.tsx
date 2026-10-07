import { StatusDot } from '@/components/status-dot'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

import { statusKey, useMonitorFormat, type MonitorStatus } from './format'

const tone: Record<ReturnType<typeof statusKey>, string> = {
  up: 'border-status-up/40 bg-status-up/10 text-foreground',
  down: 'border-status-down/40 bg-status-down/10 text-foreground',
  pending: 'border-status-pending/40 bg-status-pending/10 text-foreground',
  maintenance: 'border-status-maintenance/40 bg-status-maintenance/10 text-foreground',
  degraded: 'border-status-degraded/40 bg-status-degraded/10 text-foreground',
  unknown: 'text-muted-foreground',
}

/** Pill with a status dot and label; paused monitors read "Paused" regardless of last status. */
export function MonitorStatusBadge({
  status,
  active = true,
  className,
}: {
  status: MonitorStatus | null | undefined
  active?: boolean | null
  className?: string
}) {
  const key = statusKey(status, active)
  const { statusText } = useMonitorFormat()
  return (
    <Badge
      variant="outline"
      data-status={key}
      className={cn('gap-1.5 px-2.5 py-1 text-xs', tone[key], className)}
    >
      <StatusDot status={key} className="size-2" />
      {statusText(status, active)}
    </Badge>
  )
}
