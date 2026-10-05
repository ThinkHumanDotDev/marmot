'use client'

import * as React from 'react'
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

import { formatDateTime, formatPing } from './format'

export interface ChartBucket {
  /** Unix seconds (bucket start). */
  timestamp: number
  ping: number | null
  pingMin: number | null
  pingMax: number | null
  up: number
  down: number
}

type Point = {
  t: number
  ping: number | null
  /** [min, max] band around the average. */
  band: [number, number] | null
  up: number
  down: number
}

const hourMinute = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' })

function ChartTooltip({
  active,
  payload,
}: {
  active?: boolean
  payload?: ReadonlyArray<{ payload?: Point }>
}) {
  const point = payload?.[0]?.payload
  if (!active || !point) return null
  return (
    <div className="rounded-md border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md">
      <div className="font-medium">{formatDateTime(point.t * 1000)}</div>
      <div className="mt-1 tabular-nums">
        Avg {formatPing(point.ping)}
        {point.band && (
          <span className="text-muted-foreground">
            {' '}
            · {formatPing(point.band[0])} – {formatPing(point.band[1])}
          </span>
        )}
      </div>
      <div className="text-muted-foreground tabular-nums">
        {point.up} up · {point.down} down
      </div>
    </div>
  )
}

/**
 * Response time over the last 24 hours (one point per minute bucket). A single series: the
 * average ping line with a soft min–max band behind it; empty buckets break the line.
 */
export function ResponseTimeChart({ buckets }: { buckets: ChartBucket[] }) {
  const data = React.useMemo<Point[]>(
    () =>
      buckets.map((b) => ({
        t: b.timestamp,
        ping: b.ping,
        band: b.pingMin !== null && b.pingMax !== null ? [b.pingMin, b.pingMax] : null,
        up: b.up,
        down: b.down,
      })),
    [buckets],
  )
  const hasPing = data.some((p) => p.ping !== null)

  return (
    <Card className="gap-3" data-testid="response-time-chart">
      <CardHeader>
        <CardTitle className="text-base">Response time</CardTitle>
        <CardDescription>
          Average per minute over the last 24 hours, with min–max range.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {hasPing ? (
          <div className="h-56 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                <CartesianGrid vertical={false} stroke="var(--border)" strokeDasharray="3 3" />
                <XAxis
                  dataKey="t"
                  type="number"
                  domain={['dataMin', 'dataMax']}
                  scale="time"
                  tickFormatter={(v: number) => hourMinute.format(new Date(v * 1000))}
                  tick={{ fill: 'var(--muted-foreground)', fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                  minTickGap={48}
                />
                <YAxis
                  width={56}
                  tickFormatter={(v: number) => `${v} ms`}
                  tick={{ fill: 'var(--muted-foreground)', fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                  allowDecimals={false}
                />
                <Tooltip
                  content={<ChartTooltip />}
                  cursor={{ stroke: 'var(--muted-foreground)', strokeWidth: 1 }}
                />
                <Area
                  dataKey="band"
                  type="monotone"
                  stroke="none"
                  fill="var(--chart-1)"
                  fillOpacity={0.15}
                  connectNulls={false}
                  isAnimationActive={false}
                  activeDot={false}
                />
                <Line
                  dataKey="ping"
                  type="monotone"
                  stroke="var(--chart-1)"
                  strokeWidth={2}
                  dot={false}
                  activeDot={{ r: 4, strokeWidth: 2, stroke: 'var(--card)' }}
                  connectNulls={false}
                  isAnimationActive={false}
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <div className="flex h-56 items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground">
            No response-time data yet. The chart fills in as checks complete.
          </div>
        )}
      </CardContent>
    </Card>
  )
}
