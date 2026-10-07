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
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { api } from '@/lib/api'
import { bucketTimingAverages, TIMING_PHASES, type TimingPhase } from '@/lib/request-timing'

import { TIMING_PHASE_COLORS, useFormatPhase } from './timing-waterfall'

const RANGES = ['24h', '30d', '1y'] as const
type Range = (typeof RANGES)[number]

/** What the chart needs from a stat bucket (`GET /api/monitors/:id/stats`). */
export interface TimingBucket {
  /** Unix seconds (bucket start). */
  timestamp: number
  extras?: unknown
}

type Point = { t: number } & Record<TimingPhase, number | null>

const toPoints = (buckets: readonly TimingBucket[]): Point[] =>
  buckets.map((bucket) => {
    const averages = bucketTimingAverages(bucket.extras)
    const point = { t: bucket.timestamp } as Point
    for (const phase of TIMING_PHASES) {
      // A bucket without timing breaks the areas; a phase that did not apply stacks as 0.
      point[phase] = averages ? (averages[phase] ?? 0) : null
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
      <div className="font-medium">{format.dateTime(new Date(point.t * 1000), 'short')}</div>
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
 * Stacked area chart of the per-phase average request timing (#94) over the selected range. The
 * 24-hour data comes with the page; the other ranges are loaded from the stats API on demand.
 */
export function TimingPhasesChart({
  monitorId,
  initialBuckets,
}: {
  monitorId: string
  /** The 24-hour buckets the page already loaded. */
  initialBuckets: readonly TimingBucket[]
}) {
  const t = useTranslations('monitors.timing')
  const formatter = useFormatter()
  const formatPhase = useFormatPhase()
  const [range, setRange] = React.useState<Range>('24h')
  const [loaded, setLoaded] = React.useState<Partial<Record<Range, readonly TimingBucket[]>>>({
    '24h': initialBuckets,
  })
  const [failedRange, setFailedRange] = React.useState<Range | null>(null)
  const failed = failedRange === range
  const buckets = loaded[range]

  React.useEffect(() => {
    if (loaded[range]) return
    let cancelled = false
    api
      .get<{ buckets: TimingBucket[] }>(`/api/monitors/${encodeURIComponent(monitorId)}/stats`, {
        query: { range },
      })
      .then((stats) => {
        if (cancelled) return
        setLoaded((prev) => ({ ...prev, [range]: stats.buckets }))
        setFailedRange(null)
      })
      .catch(() => {
        if (!cancelled) setFailedRange(range)
      })
    return () => {
      cancelled = true
    }
  }, [loaded, monitorId, range])

  const data = React.useMemo(() => toPoints(buckets ?? []), [buckets])
  const hasTiming = data.some((point) => point.dns !== null)
  const tickFormat = range === '24h' ? 'time' : 'date'

  return (
    <Card className="gap-3" data-testid="timing-phases-chart">
      <CardHeader className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1.5">
          <CardTitle className="text-base">{t('chartTitle')}</CardTitle>
          <CardDescription>{t('chartDescription')}</CardDescription>
        </div>
        <Tabs value={range} onValueChange={(value) => setRange(value as Range)}>
          <TabsList aria-label={t('rangeLabel')}>
            {RANGES.map((value) => (
              <TabsTrigger key={value} value={value} data-testid={`timing-range-${value}`}>
                {t(`ranges.${value}`)}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
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
                    domain={['dataMin', 'dataMax']}
                    scale="time"
                    tickFormatter={(v: number) =>
                      formatter.dateTime(new Date(v * 1000), tickFormat)
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
            {failed ? t('loadFailed') : buckets ? t('chartEmpty') : null}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
