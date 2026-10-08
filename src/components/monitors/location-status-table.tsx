import Link from 'next/link'
import { useTranslations } from 'next-intl'

import { LocationStatusBadge } from '@/components/locations/location-badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import type { QuorumMode } from '@/lib/probe-locations'
import { cn } from '@/lib/utils'
import type { MonitorLocationRow } from '@/server/monitors/location-view'

import { useMonitorFormat } from './format'
import { locationColor } from './location-colors'
import { MonitorStatusBadge } from './status-badge'

/**
 * Per-location status of a multi-location monitor (#92): each location's own state-machine status,
 * last check and 24 h / 30 d figures. The monitor's status above is their quorum.
 */
export function LocationStatusTable({
  rows,
  quorum,
  needed,
}: {
  rows: MonitorLocationRow[]
  quorum: QuorumMode
  needed: number
}) {
  const t = useTranslations('monitors.locations')
  const format = useMonitorFormat()
  return (
    <Card className="gap-3" data-testid="location-status-table">
      <CardHeader>
        <CardTitle className="text-base">{t('title')}</CardTitle>
        <CardDescription>
          {t('description', { quorum, needed, count: rows.length })}
        </CardDescription>
      </CardHeader>
      <CardContent className="px-0 sm:px-6">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('location')}</TableHead>
              <TableHead>{t('status')}</TableHead>
              <TableHead className="text-right">{t('ping')}</TableHead>
              <TableHead className="text-right">{t('uptime24h')}</TableHead>
              <TableHead className="text-right">{t('uptime30d')}</TableHead>
              <TableHead>{t('lastCheck')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row, index) => (
              <TableRow key={row.key} data-location={row.key}>
                <TableCell>
                  <span className="flex items-center gap-2">
                    <span
                      className="size-2.5 shrink-0 rounded-full"
                      style={{ background: locationColor(index) }}
                      aria-hidden
                    />
                    <span className="font-medium">{row.name ?? t('local')}</span>
                    {row.probeStatus && row.probeStatus !== 'online' && (
                      <LocationStatusBadge status={row.probeStatus} />
                    )}
                  </span>
                </TableCell>
                <TableCell>
                  <MonitorStatusBadge status={row.status} />
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {format.ping(row.lastPing)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {format.uptime(row.uptime24h)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {format.uptime(row.uptime30d)}
                </TableCell>
                <TableCell className="max-w-72">
                  <span className="block text-xs">{format.relative(row.lastCheckAt)}</span>
                  {row.lastMsg && (
                    <span
                      className="block truncate text-xs text-muted-foreground"
                      title={row.lastMsg}
                    >
                      {row.lastMsg}
                    </span>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}

/**
 * Location filter of the detail page (#92): plain links on `?location=` so the page stays a server
 * component; it narrows the heartbeat bar, the events and the latency-by-location chart.
 */
export function LocationFilter({
  rows,
  selected,
  basePath,
}: {
  rows: Pick<MonitorLocationRow, 'key' | 'name'>[]
  selected: string | null
  basePath: string
}) {
  const t = useTranslations('monitors.locations')
  const chip = (active: boolean) =>
    cn(
      'inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs transition-colors',
      active ? 'border-foreground bg-foreground text-background' : 'hover:bg-muted',
    )
  return (
    <nav
      aria-label={t('filter')}
      className="flex flex-wrap items-center gap-2"
      data-testid="location-filter"
    >
      <span className="text-xs text-muted-foreground">{t('filter')}</span>
      <Link
        href={basePath}
        scroll={false}
        className={chip(selected === null)}
        aria-current={selected === null ? 'true' : undefined}
      >
        {t('all')}
      </Link>
      {rows.map((row, index) => (
        <Link
          key={row.key}
          href={`${basePath}?location=${encodeURIComponent(row.key)}`}
          scroll={false}
          className={chip(selected === row.key)}
          aria-current={selected === row.key ? 'true' : undefined}
        >
          <span
            className="size-2 rounded-full"
            style={{ background: locationColor(index) }}
            aria-hidden
          />
          {row.name ?? t('local')}
        </Link>
      ))}
    </nav>
  )
}
