'use client'

import { Siren } from 'lucide-react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useFormatter, useTranslations } from 'next-intl'
import * as React from 'react'

import { EmptyState } from '@/components/empty-state'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import type { DeclaredIncidentSummary } from '@/lib/declared-incidents'

import { useDeclaredIncidentEvents } from './api'
import { DeclaredStatusBadge, SeverityBadge } from './badges'

const COLUMNS = 'md:grid-cols-[minmax(0,1fr)_6rem_7rem_10rem_11rem]'

/** Declared incidents of the organization; refreshes when one changes. */
export function DeclaredList({
  orgId,
  orgSlug,
  docs,
  filter,
}: {
  orgId: string | number
  orgSlug: string
  docs: DeclaredIncidentSummary[]
  filter: 'active' | 'all'
}) {
  const t = useTranslations('declaredIncidents.list')
  const tf = useTranslations('declaredIncidents.filters')
  const format = useFormatter()
  const router = useRouter()
  const pathname = usePathname()

  const timer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useDeclaredIncidentEvents(orgId, () => {
    clearTimeout(timer.current)
    timer.current = setTimeout(() => router.refresh(), 300)
  })
  React.useEffect(() => () => clearTimeout(timer.current), [])

  return (
    <div className="flex flex-col gap-6">
      <Tabs
        value={filter}
        onValueChange={(value) =>
          router.push(value === 'all' ? `${pathname}?status=all` : pathname)
        }
      >
        <TabsList>
          <TabsTrigger value="active">{tf('active')}</TabsTrigger>
          <TabsTrigger value="all">{tf('all')}</TabsTrigger>
        </TabsList>
      </Tabs>

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
    </div>
  )
}
