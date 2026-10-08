'use client'

import { useFormatter, useTranslations } from 'next-intl'
import * as React from 'react'
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import type { LocationLatencySeries } from '@/server/monitors/location-view'

import { useMonitorFormat } from './format'
import { locationColor } from './location-colors'

type Row = { t: number } & Record<string, number | null>

function ChartTooltip({
  active,
  label,
  payload,
}: {
  active?: boolean
  label?: number
  payload?: ReadonlyArray<{ dataKey?: unknown; name?: unknown; value?: unknown; color?: string }>
}) {
  const format = useMonitorFormat()
  if (!active || !payload?.length || typeof label !== 'number') return null
  return (
    <div className="rounded-md border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md">
      <div className="font-medium">{format.dateTime(label * 1000)}</div>
      {payload.map((item) => (
        <div key={String(item.dataKey)} className="mt-1 flex items-center gap-2 tabular-nums">
          <span className="size-2 rounded-full" style={{ background: item.color }} aria-hidden />
          <span>{String(item.name)}</span>
          <span className="ml-auto pl-3">{format.ping(item.value as number | null)}</span>
        </div>
      ))}
    </div>
  )
}

/**
 * Average response time per location and hour over the last 24 hours (#92). One line per location
 * in its fixed colour (the order of the status table), a legend, and a crosshair tooltip.
 * `colorIndex` keeps a location's colour when the filter shows it alone.
 */
export function LocationLatencyChart({
  series,
}: {
  series: (LocationLatencySeries & { colorIndex: number })[]
}) {
  const t = useTranslations('monitors.locations')
  const format = useMonitorFormat()
  const formatter = useFormatter()
  const data = React.useMemo<Row[]>(() => {
    const rows = new Map<number, Row>()
    for (const s of series) {
      for (const point of s.points) {
        const row = rows.get(point.timestamp) ?? ({ t: point.timestamp } as Row)
        row[s.key] = point.ping
        rows.set(point.timestamp, row)
      }
    }
    return [...rows.values()].sort((a, b) => a.t - b.t)
  }, [series])
  const hasPing = series.some((s) => s.points.some((p) => p.ping !== null))

  return (
    <Card className="gap-3" data-testid="location-latency-chart">
      <CardHeader>
        <CardTitle className="text-base">{t('chartTitle')}</CardTitle>
        <CardDescription>{t('chartDescription')}</CardDescription>
      </CardHeader>
      <CardContent>
        {hasPing ? (
          <div className="h-64 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                <CartesianGrid vertical={false} stroke="var(--border)" strokeDasharray="3 3" />
                <XAxis
                  dataKey="t"
                  type="number"
                  domain={['dataMin', 'dataMax']}
                  scale="time"
                  tickFormatter={(v: number) => formatter.dateTime(new Date(v * 1000), 'time')}
                  tick={{ fill: 'var(--muted-foreground)', fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                  minTickGap={48}
                />
                <YAxis
                  width={56}
                  tickFormatter={(v: number) => format.ping(v)}
                  tick={{ fill: 'var(--muted-foreground)', fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                  allowDecimals={false}
                />
                <Tooltip
                  content={<ChartTooltip />}
                  cursor={{ stroke: 'var(--muted-foreground)', strokeWidth: 1 }}
                />
                {series.length > 1 && (
                  <Legend
                    iconType="circle"
                    iconSize={8}
                    wrapperStyle={{ fontSize: 12, color: 'var(--muted-foreground)' }}
                  />
                )}
                {series.map((s) => (
                  <Line
                    key={s.key}
                    dataKey={s.key}
                    name={s.name ?? t('local')}
                    type="monotone"
                    stroke={locationColor(s.colorIndex)}
                    strokeWidth={2}
                    dot={false}
                    activeDot={{ r: 4, strokeWidth: 2, stroke: 'var(--card)' }}
                    connectNulls={false}
                    isAnimationActive={false}
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <div className="flex h-64 items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground">
            {t('chartEmpty')}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
