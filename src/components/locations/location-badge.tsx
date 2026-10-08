import { RadioTower } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { Badge } from '@/components/ui/badge'
import type { LocationStatus } from '@/lib/probe-locations'
import { cn } from '@/lib/utils'

const tone: Record<LocationStatus, { badge: string; dot: string }> = {
  online: { badge: 'border-status-up/40 bg-status-up/10', dot: 'bg-status-up' },
  offline: { badge: 'border-status-down/40 bg-status-down/10', dot: 'bg-status-down' },
  unknown: { badge: 'text-muted-foreground', dot: 'bg-muted-foreground/40' },
}

/** Online / offline / never-connected pill of a probe location (#91). */
export function LocationStatusBadge({
  status,
  className,
}: {
  status: LocationStatus
  className?: string
}) {
  const t = useTranslations('settings.locations.status')
  return (
    <Badge
      variant="outline"
      data-status={status}
      data-testid="location-status"
      className={cn('gap-1.5', tone[status].badge, className)}
    >
      <span className={cn('size-2 rounded-full', tone[status].dot)} aria-hidden />
      {t(status)}
    </Badge>
  )
}

/** "Checked from <location>" chip of a probe-checked monitor, coloured by the location's status. */
export function MonitorLocationBadge({ name, status }: { name: string; status: LocationStatus }) {
  const t = useTranslations('monitors.detail')
  return (
    <Badge
      variant="outline"
      data-status={status}
      data-testid="monitor-location"
      className={cn('gap-1.5', tone[status].badge)}
      title={t('locationStatus', { status })}
    >
      <RadioTower aria-hidden />
      {t('checkedFrom', { location: name })}
      <span className={cn('size-2 rounded-full', tone[status].dot)} aria-hidden />
    </Badge>
  )
}
