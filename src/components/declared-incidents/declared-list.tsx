'use client'

import { Siren } from 'lucide-react'
import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useFormatter, useTranslations } from 'next-intl'
import * as React from 'react'

import { EmptyState } from '@/components/empty-state'
import { useDurationText } from '@/components/incidents/use-incidents'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  DECLARED_INCIDENT_SEVERITIES,
  UNASSIGNED_COMMANDER,
  type DeclaredIncidentSeverity,
  type DeclaredIncidentStats,
  type DeclaredIncidentSummary,
} from '@/lib/declared-incidents'

import { useDeclaredIncidentEvents } from './api'
import { DeclaredStatusBadge, SeverityBadge } from './badges'
import type { MemberChoice } from './declare-dialog'

const COLUMNS = 'md:grid-cols-[minmax(0,1fr)_6rem_7rem_10rem_11rem]'
const ALL = '__all__'

export interface DeclaredListFilters {
  status: 'active' | 'all'
  severity: DeclaredIncidentSeverity | null
  /** A member id or `UNASSIGNED_COMMANDER`. */
  commander: string | null
}

function StatsCards({ stats }: { stats: DeclaredIncidentStats }) {
  const t = useTranslations('declaredIncidents.stats')
  const duration = useDurationText()
  const format = useFormatter()
  const items = [
    { key: 'total', label: t('total'), value: format.number(stats.total, 'integer') },
    {
      key: 'active',
      label: t('active'),
      value: format.number(stats.active, 'integer'),
      hint: t('canceledHint', { canceled: stats.canceled }),
    },
    {
      key: 'mttm',
      label: t('mttm'),
      value: stats.meanTimeToMitigate === null ? t('noData') : duration(stats.meanTimeToMitigate),
    },
    {
      key: 'mttr',
      label: t('mttr'),
      value: stats.meanTimeToResolve === null ? t('noData') : duration(stats.meanTimeToResolve),
    },
  ]
  return (
    <section aria-label={t('label')} className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {items.map((item) => (
        <Card key={item.key} className="gap-1 py-4" data-testid={`declared-stat-${item.key}`}>
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
 * Declared incidents of the organization: status tabs, severity and commander filters (URL search
 * params, applied server-side), the time-to-mitigate/resolve summary and pagination. A
 * `declaredIncident` event refreshes the server render.
 */
export function DeclaredList({
  orgId,
  orgSlug,
  docs,
  stats,
  page,
  totalPages,
  filters,
  members,
}: {
  orgId: string | number
  orgSlug: string
  docs: DeclaredIncidentSummary[]
  stats: DeclaredIncidentStats
  page: number
  totalPages: number
  filters: DeclaredListFilters
  members: MemberChoice[]
}) {
  const t = useTranslations('declaredIncidents.list')
  const tf = useTranslations('declaredIncidents.filters')
  const ts = useTranslations('declaredIncidents.severity')
  const format = useFormatter()
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  const timer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useDeclaredIncidentEvents(orgId, () => {
    clearTimeout(timer.current)
    timer.current = setTimeout(() => router.refresh(), 300)
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
          <Tabs
            value={filters.status}
            onValueChange={(value) => navigate({ status: value === 'all' ? 'all' : null })}
          >
            <TabsList>
              <TabsTrigger value="active">{tf('active')}</TabsTrigger>
              <TabsTrigger value="all">{tf('all')}</TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
        <div className="grid gap-1.5">
          <span className="text-xs font-medium text-muted-foreground">{tf('severity')}</span>
          <Select
            value={filters.severity ?? ALL}
            onValueChange={(value) => navigate({ severity: value === ALL ? null : value })}
          >
            <SelectTrigger
              className="w-44"
              aria-label={tf('severity')}
              data-testid="declared-filter-severity"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>{tf('allSeverities')}</SelectItem>
              {DECLARED_INCIDENT_SEVERITIES.map((value) => (
                <SelectItem key={value} value={value}>
                  {ts(value)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-1.5">
          <span className="text-xs font-medium text-muted-foreground">{tf('commander')}</span>
          <Select
            value={filters.commander ?? ALL}
            onValueChange={(value) => navigate({ commander: value === ALL ? null : value })}
          >
            <SelectTrigger
              className="w-56"
              aria-label={tf('commander')}
              data-testid="declared-filter-commander"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>{tf('anyCommander')}</SelectItem>
              <SelectItem value={UNASSIGNED_COMMANDER}>{tf('unassigned')}</SelectItem>
              {members.map((member) => (
                <SelectItem key={member.id} value={member.id}>
                  {member.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <StatsCards stats={stats} />

      {docs.length === 0 ? (
        <EmptyState icon={Siren} title={t('empty')} description={t('emptyHint')} />
      ) : (
        <div className="overflow-hidden rounded-xl border bg-card">
          <div
            className={`hidden items-center gap-x-3 border-b px-4 py-2 text-xs font-medium text-muted-foreground md:grid ${COLUMNS}`}
          >
            <span>{t('incident')}</span>
            <span>{t('severity')}</span>
            <span>{t('status')}</span>
            <span>{t('commander')}</span>
            <span>{t('started')}</span>
          </div>
          <ul className="divide-y" data-testid="declared-list">
            {docs.map((incident) => (
              <li key={incident.id}>
                <Link
                  href={`/${orgSlug}/declared-incidents/${incident.id}`}
                  className={`grid gap-x-3 gap-y-1 px-4 py-3 hover:bg-muted/40 md:items-center ${COLUMNS}`}
                  data-testid="declared-row"
                >
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{incident.title}</span>
                    {incident.summary && (
                      <span className="block truncate text-xs text-muted-foreground">
                        {incident.summary}
                      </span>
                    )}
                  </span>
                  <span>
                    <SeverityBadge severity={incident.severity} />
                  </span>
                  <span>
                    <DeclaredStatusBadge status={incident.status} />
                  </span>
                  <span className="truncate text-sm">
                    {incident.commander?.name ?? (
                      <span className="text-muted-foreground">{t('noCommander')}</span>
                    )}
                  </span>
                  <span className="text-sm text-muted-foreground">
                    {format.dateTime(new Date(incident.startedAt), 'short')}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}

      {totalPages > 1 && (
        <nav
          className="flex items-center justify-between gap-3 text-sm"
          data-testid="declared-pages"
        >
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
