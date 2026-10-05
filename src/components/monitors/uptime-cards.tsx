import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { cn } from '@/lib/utils'

import { formatPing, formatUptime } from './format'

export interface UptimeSummary {
  /** 0..1 */
  uptime24h: number | null
  uptime30d: number | null
  uptime1y: number | null
  /** Average ping over 24h in ms. */
  avgPing24h: number | null
  /** Latest ping in ms. */
  lastPing: number | null
}

function tier(fraction: number | null): string {
  if (fraction === null) return 'text-muted-foreground'
  if (fraction >= 0.999) return 'text-status-up'
  if (fraction >= 0.95) return 'text-status-pending'
  return 'text-status-down'
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

/** Uptime (24h / 30d / 1y) and ping tiles, Uptime Kuma's detail header row. */
export function UptimeCards({ summary }: { summary: UptimeSummary }) {
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-5" data-testid="uptime-cards">
      <StatTile
        label="Response"
        hint="Latest check"
        value={formatPing(summary.lastPing)}
        testId="stat-response"
      />
      <StatTile
        label="Avg. response"
        hint="Last 24 hours"
        value={formatPing(summary.avgPing24h)}
        testId="stat-avg-response"
      />
      <StatTile
        label="Uptime"
        hint="Last 24 hours"
        value={formatUptime(summary.uptime24h)}
        valueClassName={tier(summary.uptime24h)}
        testId="stat-uptime-24h"
      />
      <StatTile
        label="Uptime"
        hint="Last 30 days"
        value={formatUptime(summary.uptime30d)}
        valueClassName={tier(summary.uptime30d)}
        testId="stat-uptime-30d"
      />
      <StatTile
        label="Uptime"
        hint="Last year"
        value={formatUptime(summary.uptime1y)}
        valueClassName={tier(summary.uptime1y)}
        testId="stat-uptime-1y"
      />
    </div>
  )
}
