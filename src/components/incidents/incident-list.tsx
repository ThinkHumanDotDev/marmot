'use client'

import { Siren } from 'lucide-react'
import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useFormatter, useTranslations } from 'next-intl'
import * as React from 'react'

import { EmptyState } from '@/components/empty-state'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  ACTIVE_INCIDENT_STATUSES,
  INCIDENT_RANGES,
  INCIDENT_STATUS_FILTERS,
  incidentDurationSeconds,
  type IncidentRange,
  type IncidentStats,
  type IncidentStatusFilter,
  type MonitorIncidentSummary,
} from '@/lib/monitor-incidents'

import { IncidentStatusBadge } from './incident-status-badge'
import { useDurationText, useIncidentEvents, useNow } from './use-incidents'

export interface IncidentListFiltersValue {
  status: IncidentStatusFilter
  range: IncidentRange
  monitor: string | null
}

interface IncidentListProps {
  orgId: string | number
  orgSlug: string
  docs: MonitorIncidentSummary[]
  stats: IncidentStats
  page: number
  totalPages: number
  filters: IncidentListFiltersValue
  monitors: { id: string; name: string }[]
  /** Server render time (ms), so ongoing durations hydrate identically. */
  now: number
}

const ALL = '__all__'

/** Who responded: acknowledgement for unresolved incidents, resolution for resolved ones. */
export function useResponseText() {
  const t = useTranslations('incidents.list')
  return (incident: MonitorIncidentSummary): string => {
    if (incident.status === 'resolved') {
      if (incident.autoResolved) return t('resolvedAuto')
      return incident.resolvedBy
        ? t('resolvedBy', { name: incident.resolvedBy.name })
        : t('resolvedManually')
    }
    if (incident.status === 'acknowledged') {
      return incident.acknowledgedBy
        ? t('acknowledgedBy', { name: incident.acknowledgedBy.name })
        : t('acknowledgedViaLink')
    }
    return t('notAcknowledged')
  }
}

function StatsCards({ stats }: { stats: IncidentStats }) {
  const t = useTranslations('incidents.stats')
  const duration = useDurationText()
  const format = useFormatter()
  const items = [
    { key: 'total', label: t('total'), value: format.number(stats.total, 'integer') },
    {
      key: 'unresolved',
      label: t('unresolved'),
      value: format.number(stats.open + stats.acknowledged, 'integer'),
      hint: t('unresolvedHint', { open: stats.open, acknowledged: stats.acknowledged }),
    },
    {
      key: 'mtta',
      label: t('mtta'),
      value: stats.mtta === null ? t('noData') : duration(stats.mtta),
    },
    {
      key: 'mttr',
      label: t('mttr'),
      value: stats.mttr === null ? t('noData') : duration(stats.mttr),
    },
  ]
  return (
    <section aria-label={t('label')} className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {items.map((item) => (
        <Card key={item.key} className="gap-1 py-4" data-testid={`incident-stat-${item.key}`}>
          <CardHeader className="px-4">
            <CardTitle className="text-xs font-medium text-muted-foreground">
              {item.label}
            </CardTitle>
          </CardHeader>
          <CardContent className="px-4">
            <p className="text-xl font-semibold tabular-nums">{item.value}</p>
            {item.hint && <p className="text-xs text-muted-foreground">{item.hint}</p>}
          </CardContent>
        </Card>
      ))}
    </section>
  )
}

/**
 * Incidents of the organization with filters (URL search params, applied server-side), the
 * MTTA/MTTR summary and pagination. A `monitorIncident` event refreshes the server render.
 */
export function IncidentList({
  orgId,
  orgSlug,
  docs,
  stats,
  page,
  totalPages,
  filters,
  monitors,
  now: serverNow,
}: IncidentListProps) {
  const t = useTranslations('incidents.list')
  const tf = useTranslations('incidents.filters')
  const format = useFormatter()
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const duration = useDurationText()
  const response = useResponseText()
  const hasOngoing = docs.some((doc) => ACTIVE_INCIDENT_STATUSES.includes(doc.status))
  const now = useNow(serverNow, hasOngoing)

  // Debounced: a burst of beats (several monitors failing together) refreshes once.
  const timer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useIncidentEvents(orgId, () => {
    clearTimeout(timer.current)
    timer.current = setTimeout(() => router.refresh(), 500)
  })
  React.useEffect(() => () => clearTimeout(timer.current), [])

  const navigate = (changes: Record<string, string | null>) => {
    const params = new URLSearchParams(searchParams.toString())
    for (const [key, value] of Object.entries(changes)) {
      if (value === null) params.delete(key)
      else params.set(key, value)
    }
    if (!('page' in changes)) params.delete('page')
    const query = params.toString()
    router.push(query ? `${pathname}?${query}` : pathname)
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end gap-3">
        <div className="grid gap-1.5">
          <span className="text-xs font-medium text-muted-foreground">{tf('status')}</span>
          <Select value={filters.status} onValueChange={(value) => navigate({ status: value })}>
            <SelectTrigger className="w-44" aria-label={tf('status')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {INCIDENT_STATUS_FILTERS.map((value) => (
                <SelectItem key={value} value={value}>
                  {tf(`statuses.${value}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-1.5">
          <span className="text-xs font-medium text-muted-foreground">{tf('monitor')}</span>
          <Select
            value={filters.monitor ?? ALL}
            onValueChange={(value) => navigate({ monitor: value === ALL ? null : value })}
          >
            <SelectTrigger className="w-56" aria-label={tf('monitor')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>{tf('allMonitors')}</SelectItem>
              {monitors.map((monitor) => (
                <SelectItem key={monitor.id} value={monitor.id}>
                  {monitor.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-1.5">
          <span className="text-xs font-medium text-muted-foreground">{tf('range')}</span>
          <Select value={filters.range} onValueChange={(value) => navigate({ range: value })}>
            <SelectTrigger className="w-44" aria-label={tf('range')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {INCIDENT_RANGES.map((value) => (
                <SelectItem key={value} value={value}>
                  {tf(`ranges.${value}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <StatsCards stats={stats} />

      {docs.length === 0 ? (
        <EmptyState icon={Siren} title={t('emptyTitle')} description={t('emptyDescription')} />
      ) : (
        <div className="overflow-hidden rounded-xl border bg-card">
          <div className="hidden grid-cols-[minmax(0,1fr)_8rem_11rem_10rem_minmax(0,14rem)] items-center gap-x-3 border-b px-4 py-2 text-xs font-medium text-muted-foreground md:grid">
            <span>{t('columns.monitor')}</span>
            <span>{t('columns.status')}</span>
            <span>{t('columns.started')}</span>
            <span>{t('columns.duration')}</span>
            <span>{t('columns.response')}</span>
          </div>
          <ul className="divide-y" data-testid="incident-list">
            {docs.map((incident) => {
              const ongoing = incident.status !== 'resolved'
              const seconds = incidentDurationSeconds(incident, now)
              return (
                <li key={incident.id}>
                  <Link
                    href={`/${orgSlug}/incidents/${incident.id}`}
                    className="grid gap-x-3 gap-y-1 px-4 py-3 hover:bg-muted/40 md:grid-cols-[minmax(0,1fr)_8rem_11rem_10rem_minmax(0,14rem)] md:items-center"
                    data-testid="incident-row"
                  >
                    <span className="min-w-0">
                      <span className="block truncate font-medium">
                        {incident.monitor?.name || t('unknownMonitor')}
                      </span>
                      {incident.cause && (
                        <span className="block truncate text-xs text-muted-foreground">
                          {incident.cause}
                        </span>
                      )}
                    </span>
                    <span>
                      <IncidentStatusBadge status={incident.status} />
                    </span>
                    <span className="text-sm text-muted-foreground">
                      {format.dateTime(new Date(incident.startedAt), 'short')}
                    </span>
                    <span className="text-sm tabular-nums">
                      {ongoing ? t('ongoing', { duration: duration(seconds) }) : duration(seconds)}
                    </span>
                    <span className="truncate text-sm text-muted-foreground">
                      {response(incident)}
                    </span>
                  </Link>
                </li>
              )
            })}
          </ul>
        </div>
      )}

      {totalPages > 1 && (
        <nav className="flex items-center justify-between gap-3 text-sm">
          <Button
            variant="outline"
            size="sm"
            disabled={page <= 1}
            onClick={() => navigate({ page: String(page - 1) })}
          >
            {t('previous')}
          </Button>
          <span className="text-muted-foreground">
            {t('pagination', { page, total: totalPages })}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={page >= totalPages}
            onClick={() => navigate({ page: String(page + 1) })}
          >
            {t('next')}
          </Button>
        </nav>
      )}
    </div>
  )
}
