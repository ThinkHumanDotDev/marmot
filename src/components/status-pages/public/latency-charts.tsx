'use client'

import { ChevronLeft } from 'lucide-react'
import { useFormatter, useTranslations } from 'next-intl'
import * as React from 'react'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'

import { StatusDot } from '@/components/status-dot'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import {
  CHARTS_PATH,
  componentChartPath,
  PUBLIC_CHART_RANGES,
  PUBLIC_PERCENTILES,
  type PublicChartRange,
  type PublicPercentile,
} from '@/lib/status-page-charts'
import type { PublicComponentChart } from '@/server/status-pages/latency-charts'
import type { PublicConfig } from '@/server/status-pages/public'

import { StatusPageShell } from './page-shell'
import { formatUptime } from './status-page-view'

/**
 * Percentile lines: one hue, lighter → darker as the percentile rises (an ordinal ramp of the
 * theme's chart tokens, validated for both modes with the dataviz palette check).
 */
const PERCENTILE_COLOR: Record<PublicPercentile, string> = {
  p50: 'var(--chart-2)',
  p95: 'var(--chart-4)',
  p99: 'var(--chart-5)',
}
const PERCENTILE_NUMBER: Record<PublicPercentile, number> = { p50: 50, p95: 95, p99: 99 }

type ChartPoint = PublicComponentChart['series'][number] & { t: number; healthy: number }

const toPoints = (series: PublicComponentChart['series']): ChartPoint[] =>
  series.map((point) => ({
    ...point,
    t: point.timestamp * 1000,
    // Degraded checks are counted in `up`; the bar shows them as their own segment.
    healthy: Math.max(0, point.up - point.degraded),
  }))

function useMs() {
  const t = useTranslations('statusPages.charts')
  const format = useFormatter()
  return (value: number | null | undefined) =>
    value === null || value === undefined
      ? t('noValue')
      : t('ms', { ms: format.number(value, 'integer') })
}

type TooltipProps = { active?: boolean; payload?: ReadonlyArray<{ payload?: ChartPoint }> }

function LatencyTooltip({ active, payload }: TooltipProps) {
  const t = useTranslations('statusPages.charts')
  const format = useFormatter()
  const ms = useMs()
  const point = payload?.[0]?.payload
  if (!active || !point) return null
  return (
    <div className="rounded-md border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md">
      <div className="font-medium">{format.dateTime(new Date(point.t), 'short')}</div>
      {[...PUBLIC_PERCENTILES].reverse().map((key) => (
        <div key={key} className="mt-0.5 flex items-center gap-2 tabular-nums">
          <span
            aria-hidden
            className="inline-block h-0.5 w-3 rounded"
            style={{ background: PERCENTILE_COLOR[key] }}
          />
          <span className="text-muted-foreground">
            {t('percentile', { value: PERCENTILE_NUMBER[key] })}
          </span>
          <span className="ml-auto">{ms(point[key])}</span>
        </div>
      ))}
    </div>
  )
}

function ChecksTooltip({ active, payload }: TooltipProps) {
  const t = useTranslations('statusPages.charts')
  const format = useFormatter()
  const point = payload?.[0]?.payload
  if (!active || !point) return null
  return (
    <div className="rounded-md border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md">
      <div className="font-medium">{format.dateTime(new Date(point.t), 'short')}</div>
      <div className="mt-1 tabular-nums">
        {t('countsDegraded', { up: point.up, degraded: point.degraded, down: point.down })}
      </div>
    </div>
  )
}

function Metric({ label, value, testId }: { label: string; value: string; testId: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5" data-testid={testId}>
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <span className="text-lg font-semibold tracking-tight tabular-nums">{value}</span>
    </div>
  )
}

const axisTick = { fill: 'var(--muted-foreground)', fontSize: 11 }

/**
 * One component's public charts (#113): headline figures, the p50/p95/p99 latency lines, the
 * check bars and, for multi-location monitors, a per-location table. `href` links the title to
 * the component's own chart page (on the overview).
 */
export function ComponentCharts({
  chart,
  href,
  headingLevel = 'h2',
}: {
  chart: PublicComponentChart
  href?: string
  headingLevel?: 'h1' | 'h2'
}) {
  const t = useTranslations('statusPages.charts')
  const format = useFormatter()
  const ms = useMs()
  const points = React.useMemo(() => toPoints(chart.series), [chart.series])
  const hasPing = points.some((p) => p.ping !== null)
  const hasChecks = chart.checks.total > 0
  const tickFormat = chart.range === '1d' ? 'time' : 'date'
  const domain: [number, number] =
    points.length > 0 ? [points[0].t, points[points.length - 1].t] : [0, 0]
  const Heading = headingLevel

  const xAxis = (
    <XAxis
      dataKey="t"
      type="number"
      domain={domain}
      scale="time"
      tickFormatter={(v: number) => format.dateTime(new Date(v), tickFormat)}
      tick={axisTick}
      axisLine={{ stroke: 'var(--border)' }}
      tickLine={false}
      minTickGap={40}
    />
  )
  const grid = <CartesianGrid vertical={false} stroke="var(--border)" />

  return (
    <section
      className="flex flex-col gap-5 rounded-xl border bg-card px-4 py-5 shadow-sm sm:px-5"
      data-chart-component={chart.componentId}
      aria-labelledby={`chart-${chart.componentId}`}
    >
      <div className="flex min-w-0 items-center gap-3">
        <StatusDot status={chart.status} />
        <Heading
          id={`chart-${chart.componentId}`}
          className={cn(
            'min-w-0 truncate font-semibold tracking-tight',
            headingLevel === 'h1' ? 'text-2xl' : 'text-base',
          )}
        >
          {href ? (
            <a href={href} className="underline-offset-4 hover:underline">
              {chart.name}
            </a>
          ) : (
            chart.name
          )}
        </Heading>
      </div>
      {chart.description && (
        <p className="-mt-3 text-sm text-muted-foreground">{chart.description}</p>
      )}

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        {chart.uptime !== undefined && (
          <Metric
            label={t('metrics.uptime')}
            value={chart.uptime === null ? t('noValue') : formatUptime(format, chart.uptime)}
            testId="chart-metric-uptime"
          />
        )}
        {PUBLIC_PERCENTILES.map((key) => (
          <Metric
            key={key}
            label={t(`metrics.${key}`)}
            value={ms(chart.percentiles[key])}
            testId={`chart-metric-${key}`}
          />
        ))}
      </div>

      <div className="flex flex-col gap-2" data-testid="public-latency-chart">
        <div>
          <h3 className="text-sm font-medium">{t('latencyTitle')}</h3>
          <p className="text-xs text-muted-foreground">{t('latencyDescription')}</p>
        </div>
        {hasPing ? (
          <div
            className="h-56 w-full"
            role="img"
            aria-label={t('latencySummary', {
              name: chart.name,
              p50: ms(chart.percentiles.p50),
              p95: ms(chart.percentiles.p95),
              p99: ms(chart.percentiles.p99),
            })}
          >
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={points} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                {grid}
                {xAxis}
                <YAxis
                  width={52}
                  tickFormatter={(v: number) => ms(v)}
                  tick={axisTick}
                  axisLine={false}
                  tickLine={false}
                  allowDecimals={false}
                />
                <Tooltip
                  content={<LatencyTooltip />}
                  cursor={{ stroke: 'var(--muted-foreground)', strokeWidth: 1 }}
                />
                <Legend
                  verticalAlign="top"
                  height={28}
                  iconType="plainline"
                  wrapperStyle={{ fontSize: 12, color: 'var(--muted-foreground)' }}
                />
                {PUBLIC_PERCENTILES.map((key) => (
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
              </LineChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <div className="flex h-56 items-center justify-center rounded-lg border border-dashed px-4 text-center text-sm text-muted-foreground">
            {t('latencyEmpty')}
          </div>
        )}
      </div>

      <div className="flex flex-col gap-2" data-testid="public-checks-chart">
        <div>
          <h3 className="text-sm font-medium">{t('checksTitle')}</h3>
          <p className="text-xs text-muted-foreground">{t('checksDescription')}</p>
        </div>
        {hasChecks ? (
          <div
            className="h-32 w-full"
            role="img"
            aria-label={t('checksSummary', {
              name: chart.name,
              total: chart.checks.total,
              failed: chart.checks.failed,
              degraded: chart.checks.degraded,
            })}
          >
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={points}
                margin={{ top: 8, right: 8, bottom: 0, left: 0 }}
                barCategoryGap={1}
              >
                {grid}
                {xAxis}
                <YAxis
                  width={52}
                  tick={axisTick}
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
                  name={t('series.up')}
                  stackId="checks"
                  fill="var(--status-up)"
                  isAnimationActive={false}
                />
                <Bar
                  dataKey="degraded"
                  name={t('series.degraded')}
                  stackId="checks"
                  fill="var(--status-degraded)"
                  isAnimationActive={false}
                />
                <Bar
                  dataKey="down"
                  name={t('series.down')}
                  stackId="checks"
                  fill="var(--status-down)"
                  isAnimationActive={false}
                />
              </BarChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <div className="flex h-32 items-center justify-center rounded-lg border border-dashed px-4 text-center text-sm text-muted-foreground">
            {t('checksEmpty')}
          </div>
        )}
      </div>

      {chart.locations.length > 0 && (
        <div className="flex flex-col gap-2" data-testid="public-location-table">
          <div>
            <h3 className="text-sm font-medium">{t('locations.title')}</h3>
            <p className="text-xs text-muted-foreground">{t('locations.description')}</p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted-foreground">
                <tr className="border-b">
                  <th scope="col" className="py-1.5 pr-3 font-medium">
                    {t('locations.location')}
                  </th>
                  {chart.uptime !== undefined && (
                    <th scope="col" className="py-1.5 pr-3 text-right font-medium">
                      {t('locations.uptime')}
                    </th>
                  )}
                  <th scope="col" className="py-1.5 pr-3 text-right font-medium">
                    {t('locations.average')}
                  </th>
                  <th scope="col" className="py-1.5 text-right font-medium">
                    {t('locations.p95')}
                  </th>
                </tr>
              </thead>
              <tbody className="tabular-nums">
                {chart.locations.map((location, i) => (
                  <tr key={`${location.name ?? ''}-${i}`} className="border-b last:border-0">
                    <th scope="row" className="py-1.5 pr-3 text-left font-normal">
                      {location.name ?? t('locations.primary')}
                    </th>
                    {chart.uptime !== undefined && (
                      <td className="py-1.5 pr-3 text-right">
                        {location.uptime === null || location.uptime === undefined
                          ? t('noValue')
                          : formatUptime(format, location.uptime)}
                      </td>
                    )}
                    <td className="py-1.5 pr-3 text-right">{ms(location.avgPing)}</td>
                    <td className="py-1.5 text-right">{ms(location.p95)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  )
}

/** Period links (plain GET links, so they work without JavaScript). */
function RangePicker({ range, action }: { range: PublicChartRange; action: string }) {
  const t = useTranslations('statusPages.charts')
  return (
    <nav aria-label={t('period')} className="flex flex-wrap gap-1.5">
      {PUBLIC_CHART_RANGES.map((value) => (
        <Button
          key={value}
          asChild
          size="sm"
          variant={range === value ? 'default' : 'outline'}
          data-testid={`chart-range-${value}`}
        >
          <a href={`${action}?range=${value}`} aria-current={range === value ? 'page' : undefined}>
            {t(`periods.${value}`)}
          </a>
        </Button>
      ))}
    </nav>
  )
}

/**
 * `/status/:slug/monitors` (every charted component) and `/status/:slug/monitors/:componentId`
 * (one of them, `single`).
 */
export function LatencyChartsView({
  config,
  basePath,
  range,
  charts,
  single = false,
}: {
  config: PublicConfig
  basePath: string
  range: PublicChartRange
  charts: PublicComponentChart[]
  single?: boolean
}) {
  const t = useTranslations('statusPages.charts')
  const overview = `${basePath}${CHARTS_PATH}`
  const action =
    single && charts[0] ? `${basePath}${componentChartPath(charts[0].componentId)}` : overview

  return (
    <StatusPageShell config={config} basePath={basePath}>
      {single ? (
        <a
          href={`${overview}?range=${range}`}
          className="-mb-4 inline-flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="size-4" aria-hidden />
          {t('allCharts')}
        </a>
      ) : (
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight">{t('heading')}</h1>
          <p className="text-sm text-muted-foreground">{t('description')}</p>
        </div>
      )}
      <RangePicker range={range} action={action} />
      {charts.length === 0 ? (
        <p className="rounded-xl border border-dashed px-5 py-8 text-center text-sm text-muted-foreground">
          {t('empty')}
        </p>
      ) : (
        <div className="flex flex-col gap-6">
          {charts.map((chart) => (
            <ComponentCharts
              key={chart.componentId}
              chart={chart}
              headingLevel={single ? 'h1' : 'h2'}
              href={
                single
                  ? undefined
                  : `${basePath}${componentChartPath(chart.componentId)}?range=${range}`
              }
            />
          ))}
        </div>
      )}
    </StatusPageShell>
  )
}
