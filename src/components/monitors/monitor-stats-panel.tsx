'use client'

import { useFormatter, useTranslations } from 'next-intl'
import * as React from 'react'
import {
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

import { useMonitorFormat } from './format'

/** Mirrors `CHART_RANGES` / `PERCENTILES` in `src/server/stats` (kept here to stay client-only). */
export const STATS_PANEL_RANGES = ['1d', '7d', '14d', '30d', '90d'] as const
export type StatsPanelRange = (typeof STATS_PANEL_RANGES)[number]
const PERCENTILE_KEYS = ['p50', 'p75', 'p90', 'p95', 'p99'] as const
type PercentileKey = (typeof PERCENTILE_KEYS)[number]
const PERCENTILE_NUMBER: Record<PercentileKey, number> = {
  p50: 50,
  p75: 75,
  p90: 90,
  p95: 95,
  p99: 99,
}
/** One sequential hue, light → dark as the percentile rises. */
const PERCENTILE_COLOR: Record<PercentileKey, string> = {
  p50: 'var(--chart-3)',
  p75: 'var(--chart-2)',
  p90: 'var(--chart-1)',
  p95: 'var(--chart-4)',
  p99: 'var(--chart-5)',
}

export type StatsPanelPoint = {
  timestamp: number
  up: number
  down: number
  degraded: number
  maintenance: number
  ping: number | null
} & Partial<Record<PercentileKey, number | null>>

/** The part of `GET /api/monitors/:id/stats` (`RangeStats`) the panel uses. */
export interface StatsPanelData {
  range: string
  uptime: number
  avgPing: number | null
  percentiles: Record<PercentileKey, number | null>
  checks: { total: number; up: number; failed: number; degraded: number; maintenance: number }
  step: number
  series: StatsPanelPoint[]
}

type ChartPoint = StatsPanelPoint & { t: number; healthy: number }

const toPoints = (series: StatsPanelPoint[]): ChartPoint[] =>
  series.map((point) => ({
    ...point,
    t: point.timestamp * 1000,
    // Degraded checks are counted in `up`; the bar shows them as their own segment.
    healthy: Math.max(0, point.up - point.degraded),
  }))

function LatencyTooltip({
  active,
  payload,
  selected,
}: {
  active?: boolean
  payload?: ReadonlyArray<{ payload?: ChartPoint }>
  selected: PercentileKey[]
}) {
  const t = useTranslations('monitors.chart')
  const format = useMonitorFormat()
  const formatter = useFormatter()
  const point = payload?.[0]?.payload
  if (!active || !point) return null
  return (
    <div className="rounded-md border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md">
      <div className="font-medium">{formatter.dateTime(new Date(point.t), 'short')}</div>
      {selected.map((key) => (
        <div key={key} className="mt-0.5 flex items-center gap-2 tabular-nums">
          <span
            aria-hidden
            className="inline-block h-0.5 w-3 rounded"
            style={{ background: PERCENTILE_COLOR[key] }}
          />
          {t('percentileValue', {
            value: PERCENTILE_NUMBER[key],
            ping: format.ping(point[key] ?? null),
          })}
        </div>
      ))}
      <div className="mt-0.5 text-muted-foreground tabular-nums">
        {t('average', { ping: format.ping(point.ping) })}
      </div>
    </div>
  )
}

function ChecksTooltip({
  active,
  payload,
}: {
  active?: boolean
  payload?: ReadonlyArray<{ payload?: ChartPoint }>
}) {
  const t = useTranslations('monitors.chart')
  const formatter = useFormatter()
  const point = payload?.[0]?.payload
  if (!active || !point) return null
  return (
    <div className="rounded-md border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md">
      <div className="font-medium">{formatter.dateTime(new Date(point.t), 'short')}</div>
      <div className="mt-1 tabular-nums">
        {t('countsDegraded', { up: point.up, degraded: point.degraded, down: point.down })}
      </div>
    </div>
  )
}

function Metric({
  label,
  value,
  testId,
  className,
}: {
  label: string
  value: string
  testId: string
  className?: string
}) {
  return (
    <div className="flex flex-col gap-1" data-testid={testId}>
      <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
        {label}
      </span>
      <span className={cn('text-xl font-semibold tabular-nums tracking-tight', className)}>
        {value}
      </span>
    </div>
  )
}

/**
 * Period and percentile selectors, the latency chart (percentile lines + average), the check
 * bars (up / degraded / down per interval) and the metrics row of the monitor detail page (#95).
 * Everything comes from `GET /api/monitors/:id/stats`, i.e. from the stat rollups; switching the
 * period refetches, switching percentiles only redraws.
 */
export function MonitorStatsPanel({
  monitorId,
  initial,
  lastCheckAt,
}: {
  monitorId: string
  initial: StatsPanelData
  lastCheckAt: string | null | undefined
}) {
  const t = useTranslations('monitors.chart')
  const tMetrics = useTranslations('monitors.metrics')
  const tStatus = useTranslations('common.status')
  const format = useMonitorFormat()
  const formatter = useFormatter()

  const [range, setRange] = React.useState<StatsPanelRange>('1d')
  const [selected, setSelected] = React.useState<PercentileKey[]>(['p50', 'p95', 'p99'])
  const cache = React.useRef(new Map<string, StatsPanelData>([[range, initial]]))
  const [data, setData] = React.useState<StatsPanelData>(initial)
  const [loading, setLoading] = React.useState(false)
  const [failed, setFailed] = React.useState(false)

  React.useEffect(() => {
    const cached = cache.current.get(range)
    if (cached) {
      setData(cached)
      setFailed(false)
      return
    }
    const controller = new AbortController()
    setLoading(true)
    setFailed(false)
    api
      .get<StatsPanelData>(`/api/monitors/${encodeURIComponent(monitorId)}/stats`, {
        query: { range },
        signal: controller.signal,
      })
      .then((result) => {
        cache.current.set(range, result)
        setData(result)
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true)
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [monitorId, range])

  const points = React.useMemo(() => toPoints(data.series), [data.series])
  const hasPing = points.some((p) => p.ping !== null)
  const hasChecks = points.some((p) => p.up + p.down > 0)
  const active = PERCENTILE_KEYS.filter((key) => selected.includes(key))
  const headline = active.at(-1) ?? 'p95'
  const tickFormat = range === '1d' ? 'time' : 'date'
  const domain: [number, number] =
    points.length > 0 ? [points[0].t, points[points.length - 1].t] : [0, 0]

  const togglePercentile = (key: PercentileKey) =>
    setSelected((current) =>
      current.includes(key) ? current.filter((k) => k !== key) : [...current, key],
    )

  const xAxis = (
    <XAxis
      dataKey="t"
      type="number"
      domain={domain}
      scale="time"
      tickFormatter={(v: number) => formatter.dateTime(new Date(v), tickFormat)}
      tick={{ fill: 'var(--muted-foreground)', fontSize: 11 }}
      axisLine={false}
      tickLine={false}
      minTickGap={48}
    />
  )

  return (
    <div className="flex flex-col gap-6" data-testid="monitor-stats-panel" aria-busy={loading}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div role="group" aria-label={t('period')} className="flex flex-wrap gap-1.5">
          {STATS_PANEL_RANGES.map((value) => (
            <Button
              key={value}
              type="button"
              size="sm"
              variant={range === value ? 'default' : 'outline'}
              aria-pressed={range === value}
              data-testid={`stats-range-${value}`}
              onClick={() => setRange(value)}
            >
              {t(`periods.${value}`)}
            </Button>
          ))}
        </div>
        <div role="group" aria-label={t('percentiles')} className="flex flex-wrap gap-1.5">
          {PERCENTILE_KEYS.map((key) => (
            <Button
              key={key}
              type="button"
              size="sm"
              variant={selected.includes(key) ? 'secondary' : 'ghost'}
              aria-pressed={selected.includes(key)}
              data-testid={`stats-percentile-${key}`}
              onClick={() => togglePercentile(key)}
            >
              <span
                aria-hidden
                className="inline-block size-2 rounded-full"
                style={{ background: PERCENTILE_COLOR[key] }}
              />
              {t('percentile', { value: PERCENTILE_NUMBER[key] })}
            </Button>
          ))}
        </div>
      </div>

      {failed && (
        <p className="text-sm text-status-down-text" role="alert">
          {t('loadError')}
        </p>
      )}

      <Card className="gap-4 py-4" data-testid="monitor-metrics">
        <CardContent className="grid grid-cols-2 gap-4 px-4 sm:grid-cols-3 lg:grid-cols-6">
          <Metric
            label={tMetrics('uptime')}
            value={data.checks.total > 0 ? format.uptime(data.uptime) : '–'}
            testId="metric-uptime"
          />
          <Metric
            label={tMetrics('percentileResponse', { value: PERCENTILE_NUMBER[headline] })}
            value={format.ping(data.percentiles[headline])}
            testId="metric-percentile"
          />
          <Metric
            label={tMetrics('totalChecks')}
            value={formatter.number(data.checks.total, 'integer')}
            testId="metric-total-checks"
          />
          <Metric
            label={tMetrics('failedChecks')}
            value={formatter.number(data.checks.failed, 'integer')}
            className={data.checks.failed > 0 ? 'text-status-down-text' : undefined}
            testId="metric-failed-checks"
          />
          <Metric
            label={tMetrics('degradedChecks')}
            value={formatter.number(data.checks.degraded, 'integer')}
            className={data.checks.degraded > 0 ? 'text-status-degraded-text' : undefined}
            testId="metric-degraded-checks"
          />
          <Metric
            label={tMetrics('lastCheck')}
            value={format.dateTime(lastCheckAt)}
            testId="metric-last-check"
          />
        </CardContent>
      </Card>

      <Card className="gap-3" data-testid="response-time-chart">
        <CardHeader>
          <CardTitle className="text-base">{t('title')}</CardTitle>
          <CardDescription>{t('description')}</CardDescription>
        </CardHeader>
        <CardContent>
          {hasPing ? (
            <div className="h-64 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={points} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                  <CartesianGrid vertical={false} stroke="var(--border)" strokeDasharray="3 3" />
                  {xAxis}
                  <YAxis
                    width={56}
                    tickFormatter={(v: number) => format.ping(v)}
                    tick={{ fill: 'var(--muted-foreground)', fontSize: 11 }}
                    axisLine={false}
                    tickLine={false}
                    allowDecimals={false}
                  />
                  <Tooltip
                    content={<LatencyTooltip selected={active} />}
                    cursor={{ stroke: 'var(--muted-foreground)', strokeWidth: 1 }}
                  />
                  <Legend
                    verticalAlign="top"
                    height={28}
                    iconType="plainline"
                    wrapperStyle={{ fontSize: 12, color: 'var(--muted-foreground)' }}
                  />
                  <Line
                    dataKey="ping"
                    name={t('averageLegend')}
                    type="monotone"
                    stroke="var(--muted-foreground)"
                    strokeDasharray="4 3"
                    strokeWidth={1.5}
                    dot={false}
                    activeDot={false}
                    connectNulls={false}
                    isAnimationActive={false}
                  />
                  {active.map((key) => (
                    <Line
                      key={key}
                      dataKey={key}
                      name={t('percentile', { value: PERCENTILE_NUMBER[key] })}
                      type="monotone"
                      stroke={PERCENTILE_COLOR[key]}
                      strokeWidth={2}
                      dot={false}
                      activeDot={{ r: 4, strokeWidth: 2, stroke: 'var(--card)' }}
                      connectNulls={false}
                      isAnimationActive={false}
                    />
                  ))}
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <div className="flex h-64 items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground">
              {t('empty')}
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="gap-3" data-testid="checks-chart">
        <CardHeader>
          <CardTitle className="text-base">{t('checksTitle')}</CardTitle>
          <CardDescription>{t('checksDescription')}</CardDescription>
        </CardHeader>
        <CardContent>
          {hasChecks ? (
            <div className="h-40 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={points}
                  margin={{ top: 8, right: 8, bottom: 0, left: 0 }}
                  barCategoryGap={1}
                >
                  <CartesianGrid vertical={false} stroke="var(--border)" strokeDasharray="3 3" />
                  {xAxis}
                  <YAxis
                    width={56}
                    tick={{ fill: 'var(--muted-foreground)', fontSize: 11 }}
                    axisLine={false}
                    tickLine={false}
                    allowDecimals={false}
                  />
                  <Tooltip content={<ChecksTooltip />} cursor={{ fill: 'var(--muted)' }} />
                  <Legend
                    verticalAlign="top"
                    height={28}
                    iconType="square"
                    wrapperStyle={{ fontSize: 12, color: 'var(--muted-foreground)' }}
                  />
                  <Bar
                    dataKey="healthy"
                    name={tStatus('up')}
                    stackId="checks"
                    fill="var(--status-up)"
                    isAnimationActive={false}
                  />
                  <Bar
                    dataKey="degraded"
                    name={tStatus('degraded')}
                    stackId="checks"
                    fill="var(--status-degraded)"
                    isAnimationActive={false}
                  />
                  <Bar
                    dataKey="down"
                    name={tStatus('down')}
                    stackId="checks"
                    fill="var(--status-down)"
                    isAnimationActive={false}
                  />
                </BarChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <div className="flex h-40 items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground">
              {t('checksEmpty')}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
