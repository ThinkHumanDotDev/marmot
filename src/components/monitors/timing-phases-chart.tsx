'use client'

import { useFormatter, useTranslations } from 'next-intl'
import * as React from 'react'
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { parseRequestTiming, TIMING_PHASES, type TimingPhase } from '@/lib/request-timing'

import { TIMING_PHASE_COLORS, useFormatPhase } from './timing-waterfall'

/** One chart interval: the `series` points of `GET /api/monitors/:id/stats`. */
export interface TimingSeriesPoint {
  /** Unix seconds (interval start). */
  timestamp: number
  /** Average phases of the interval (#94); absent when nothing was measured. */
  timing?: unknown
}

type Point = { t: number } & Record<TimingPhase, number | null>

const toPoints = (series: readonly TimingSeriesPoint[]): Point[] =>
  series.map((entry) => {
    const timing = parseRequestTiming(entry.timing)
    const point = { t: entry.timestamp * 1000 } as Point
    for (const phase of TIMING_PHASES) {
      // An interval without timing breaks the areas; a phase that did not apply stacks as 0.
      point[phase] = timing ? (timing[phase] ?? 0) : null
    }
    return point
  })

function ChartTooltip({
  active,
  payload,
}: {
  active?: boolean
  payload?: ReadonlyArray<{ payload?: Point }>
}) {
  const t = useTranslations('monitors.timing')
  const format = useFormatter()
  const formatPhase = useFormatPhase()
  const point = payload?.[0]?.payload
  if (!active || !point || point.dns === null) return null
  return (
    <div className="rounded-md border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md">
      <div className="font-medium">{format.dateTime(new Date(point.t), 'short')}</div>
      <ul className="mt-1 flex flex-col gap-0.5">
        {[...TIMING_PHASES].reverse().map((phase) => (
          <li key={phase} className="flex items-center justify-between gap-4">
            <span className="flex items-center gap-1.5 text-muted-foreground">
              <span
                aria-hidden
                className="size-2 rounded-full"
                style={{ background: TIMING_PHASE_COLORS[phase] }}
              />
              {t(`phases.${phase}`)}
            </span>
            <span className="tabular-nums">{formatPhase(point[phase])}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/**
 * Stacked area chart of the per-phase average request timing (#94), one point per chart interval.
 * Presentational: `MonitorStatsPanel` passes the series of its selected period.
 */
export function TimingPhasesChart({
  series,
  dailyTicks = false,
}: {
  series: readonly TimingSeriesPoint[]
  /** Label the x axis with dates instead of times (periods longer than a day). */
  dailyTicks?: boolean
}) {
  const t = useTranslations('monitors.timing')
  const formatter = useFormatter()
  const formatPhase = useFormatPhase()
  const data = React.useMemo(() => toPoints(series), [series])
  const hasTiming = data.some((point) => point.dns !== null)
  const domain: [number, number] = data.length > 0 ? [data[0].t, data[data.length - 1].t] : [0, 0]

  return (
    <Card className="gap-3" data-testid="timing-phases-chart">
      <CardHeader>
        <CardTitle className="text-base">{t('chartTitle')}</CardTitle>
        <CardDescription>{t('chartDescription')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {hasTiming ? (
          <>
            <div className="h-56 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                  <CartesianGrid vertical={false} stroke="var(--border)" strokeDasharray="3 3" />
                  <XAxis
                    dataKey="t"
                    type="number"
                    domain={domain}
                    scale="time"
                    tickFormatter={(v: number) =>
                      formatter.dateTime(new Date(v), dailyTicks ? 'date' : 'time')
                    }
                    tick={{ fill: 'var(--muted-foreground)', fontSize: 11 }}
                    axisLine={false}
                    tickLine={false}
                    minTickGap={48}
                  />
                  <YAxis
                    width={56}
                    tickFormatter={(v: number) => formatPhase(v)}
                    tick={{ fill: 'var(--muted-foreground)', fontSize: 11 }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <Tooltip
                    content={<ChartTooltip />}
                    cursor={{ stroke: 'var(--muted-foreground)', strokeWidth: 1 }}
                  />
                  {TIMING_PHASES.map((phase) => (
                    <Area
                      key={phase}
                      dataKey={phase}
                      stackId="timing"
                      type="monotone"
                      stroke="var(--card)"
                      strokeWidth={1}
                      fill={TIMING_PHASE_COLORS[phase]}
                      fillOpacity={0.85}
                      connectNulls={false}
                      isAnimationActive={false}
                      activeDot={false}
                    />
                  ))}
                </AreaChart>
              </ResponsiveContainer>
            </div>
            <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
              {TIMING_PHASES.map((phase) => (
                <li key={phase} className="flex items-center gap-1.5">
                  <span
                    aria-hidden
                    className="size-2 rounded-full"
                    style={{ background: TIMING_PHASE_COLORS[phase] }}
                  />
                  {t(`phases.${phase}`)}
                </li>
              ))}
            </ul>
          </>
        ) : (
          <div className="flex h-56 items-center justify-center rounded-lg border border-dashed px-4 text-center text-sm text-muted-foreground">
            {t('chartEmpty')}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
