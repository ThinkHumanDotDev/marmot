import { useTranslations } from 'next-intl'

import { Badge } from '@/components/ui/badge'
import type { DeclaredIncidentSeverity, DeclaredIncidentStatus } from '@/lib/declared-incidents'
import { cn } from '@/lib/utils'

const severityTone: Record<DeclaredIncidentSeverity, string> = {
  critical: 'border-status-down/50 bg-status-down/15 text-foreground',
  major: 'border-status-pending/50 bg-status-pending/15 text-foreground',
  minor: 'text-muted-foreground',
}

const statusTone: Record<DeclaredIncidentStatus, string> = {
  open: 'border-status-down/40 bg-status-down/10 text-foreground',
  mitigated: 'border-status-pending/40 bg-status-pending/10 text-foreground',
  resolved: 'border-status-up/40 bg-status-up/10 text-foreground',
  closed: 'text-muted-foreground',
  canceled: 'text-muted-foreground line-through',
}

export function SeverityBadge({ severity }: { severity: DeclaredIncidentSeverity }) {
  const t = useTranslations('declaredIncidents.severity')
  return (
    <Badge
      variant="outline"
      data-testid="declared-severity"
      data-severity={severity}
      className={cn('px-2 py-0.5 text-xs', severityTone[severity])}
    >
      {t(severity)}
    </Badge>
  )
}

export function DeclaredStatusBadge({ status }: { status: DeclaredIncidentStatus }) {
  const t = useTranslations('declaredIncidents.status')
  return (
    <Badge
      variant="outline"
      data-testid="declared-status"
      data-status={status}
      className={cn('px-2 py-0.5 text-xs', statusTone[status])}
    >
      {t(status)}
    </Badge>
  )
}
