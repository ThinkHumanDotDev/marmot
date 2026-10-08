import { useTranslations } from 'next-intl'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { cn } from '@/lib/utils'

import { useMonitorFormat } from './format'

export interface UptimeSummary {
  /** 0..1 */
  uptime24h: number | null
  uptime30d: number | null
  uptime1y: number | null
  /** Average ping over 24h in ms. */
  avgPing24h: number | null
  /** Latest ping in ms. */
  lastPing: number | null
  /** Degraded checks over 24h (slower than the monitor's threshold, counted as up). */
  degraded24h?: number | null
}

function tier(fraction: number | null): string {
  if (fraction === null) return 'text-muted-foreground'
  if (fraction >= 0.999) return 'text-status-up-text'
  if (fraction >= 0.95) return 'text-status-pending-text'
  return 'text-status-down-text'
}

function StatTile({
  label,
  hint,
  value,
  valueClassName,
  testId,
}: {
  label: string
  hint: string
  value: string
  valueClassName?: string
  testId: string
}) {
  return (
    <Card className="gap-2 py-4" data-testid={testId}>
      <CardHeader className="px-4">
        <CardDescription className="text-xs font-medium uppercase tracking-wide">
          {label}
        </CardDescription>
        <CardTitle
          className={cn('text-2xl font-semibold tabular-nums tracking-tight', valueClassName)}
        >
          {value}
        </CardTitle>
      </CardHeader>
      <CardContent className="px-4 text-xs text-muted-foreground">{hint}</CardContent>
    </Card>
  )
}

/**
 * Uptime (24h / 30d / 1y) and ping tiles, Uptime Kuma's detail header row. `showYear={false}`
 * drops the 1y tile when the organization's plan keeps less history.
 */
export function UptimeCards({
  summary,
  showYear = true,
}: {
  summary: UptimeSummary
  showYear?: boolean
}) {
  const t = useTranslations('monitors.stats')
  const format = useMonitorFormat()
  return (
    <div
      className={cn('grid grid-cols-2 gap-3', showYear ? 'md:grid-cols-5' : 'md:grid-cols-4')}
      data-testid="uptime-cards"
    >
      <StatTile
        label={t('response')}
        hint={t('latestCheck')}
        value={format.ping(summary.lastPing)}
        testId="stat-response"
      />
      <StatTile
        label={t('avgResponse')}
        hint={t('last24Hours')}
        value={format.ping(summary.avgPing24h)}
        testId="stat-avg-response"
      />
      <StatTile
        label={t('uptime')}
        hint={
          summary.degraded24h
            ? t('last24HoursDegraded', { count: summary.degraded24h })
            : t('last24Hours')
        }
        value={format.uptime(summary.uptime24h)}
        valueClassName={tier(summary.uptime24h)}
        testId="stat-uptime-24h"
      />
      <StatTile
        label={t('uptime')}
        hint={t('last30Days')}
        value={format.uptime(summary.uptime30d)}
        valueClassName={tier(summary.uptime30d)}
        testId="stat-uptime-30d"
      />
      {showYear && (
        <StatTile
          label={t('uptime')}
          hint={t('lastYear')}
          value={format.uptime(summary.uptime1y)}
          valueClassName={tier(summary.uptime1y)}
          testId="stat-uptime-1y"
        />
      )}
    </div>
  )
}
