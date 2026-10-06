import { StatusDot } from '@/components/status-dot'
import { Badge } from '@/components/ui/badge'
import { MAINTENANCE_STATUS_LABELS, type MaintenanceStatus } from '@/lib/validation/maintenance'
import { cn } from '@/lib/utils'
import type { MonitorStatusKey } from '@/stores/monitor-store'

/** Maintenance status → the status-dot palette (running windows use the maintenance colour). */
const dot: Record<MaintenanceStatus, MonitorStatusKey> = {
  'under-maintenance': 'maintenance',
  scheduled: 'pending',
  ended: 'unknown',
  inactive: 'unknown',
  unknown: 'unknown',
}

const tone: Record<MaintenanceStatus, string> = {
  'under-maintenance': 'border-status-maintenance/40 bg-status-maintenance/10 text-foreground',
  scheduled: 'border-status-pending/40 bg-status-pending/10 text-foreground',
  ended: 'text-muted-foreground',
  inactive: 'text-muted-foreground',
  unknown: 'text-muted-foreground',
}

export function MaintenanceStatusBadge({
  status,
  className,
}: {
  status: MaintenanceStatus
  className?: string
}) {
  return (
    <Badge
      variant="outline"
      data-status={status}
      className={cn('gap-1.5 px-2.5 py-1 text-xs', tone[status], className)}
    >
      <StatusDot status={dot[status]} className="size-2" pulse={false} />
      {MAINTENANCE_STATUS_LABELS[status]}
    </Badge>
  )
}
