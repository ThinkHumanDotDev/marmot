import { useTranslations } from 'next-intl'

import { StatusDot } from '@/components/status-dot'
import { Badge } from '@/components/ui/badge'
import type { MonitorIncidentStatus } from '@/lib/monitor-incidents'
import { cn } from '@/lib/utils'
import type { MonitorStatusKey } from '@/stores/monitor-store'

/** Incident status → the status-dot palette: open is an outage, acknowledged is being handled. */
const dot: Record<MonitorIncidentStatus, MonitorStatusKey> = {
  open: 'down',
  acknowledged: 'pending',
  resolved: 'up',
}

const tone: Record<MonitorIncidentStatus, string> = {
  open: 'border-status-down/40 bg-status-down/10 text-foreground',
  acknowledged: 'border-status-pending/40 bg-status-pending/10 text-foreground',
  resolved: 'text-muted-foreground',
}

export function IncidentStatusBadge({
  status,
  className,
}: {
  status: MonitorIncidentStatus
  className?: string
}) {
  const t = useTranslations('incidents.status')
  return (
    <Badge
      variant="outline"
      data-status={status}
      data-testid="incident-status"
      className={cn('gap-1.5 px-2.5 py-1 text-xs', tone[status], className)}
    >
      <StatusDot status={dot[status]} className="size-2" pulse={status === 'open'} />
      {t(status)}
    </Badge>
  )
}
