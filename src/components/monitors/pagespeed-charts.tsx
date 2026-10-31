'use client'

import { ExternalLink } from 'lucide-react'
import { useFormatter, useTranslations } from 'next-intl'
import * as React from 'react'
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  PAGESPEED_CATEGORIES,
  type PagespeedCategory,
  type PagespeedMetric,
  type PagespeedRun,
  type PagespeedSeriesKey,
} from '@/lib/pagespeed'
import { cn } from '@/lib/utils'

import { useMonitorFormat } from './format'

/** One chart interval of `GET /api/monitors/:id/stats` (`SeriesPoint.pagespeed`, #137). */
export interface PagespeedSeriesPoint {
  /** Unix seconds (interval start). */
  timestamp: number
  pagespeed?: Record<string, { avg: number; min: number; max: number; count: number }>
}

/** Timing metrics charted together (ms); CLS has no unit and gets its own chart. */
const TIMING_METRICS = [
  'lcp',
  'fcp',
  'tbt',
  'si',
  'ttfb',
  'inp',
] as const satisfies readonly Exclude<PagespeedMetric, 'cls'>[]

const CATEGORY_COLORS: Record<PagespeedCategory, string> = {
  performance: 'var(--series-1)',
  accessibility: 'var(--series-2)',
  'best-practices': 'var(--series-3)',
  seo: 'var(--series-7)',
}
const METRIC_COLORS: Record<(typeof TIMING_METRICS)[number], string> = {
  lcp: 'var(--series-1)',
  fcp: 'var(--series-2)',
  tbt: 'var(--series-3)',
  si: 'var(--series-4)',
  ttfb: 'var(--series-5)',
  inp: 'var(--series-7)',
}

type Point = { t: number } & Partial<Record<PagespeedSeriesKey, number | null>>

const toPoints = (series: readonly PagespeedSeriesPoint[]): Point[] =>
  series.map((entry) => {
    const point: Point = { t: entry.timestamp * 1000 }
    for (const [key, value] of Object.entries(entry.pagespeed ?? {})) {
      point[key as PagespeedSeriesKey] = value.avg
    }
    return point
  })

/** Lighthouse's own bands: 90–100 good, 50–89 needs improvement, 0–49 poor. */
export function scoreTone(score: number): 'good' | 'average' | 'poor' {
  if (score >= 90) return 'good'
  if (score >= 50) return 'average'
  return 'poor'
}

const TONE_CLASS = {
  good: 'border-status-up text-status-up-text',
  average: 'border-status-degraded text-status-degraded-text',
  poor: 'border-status-down text-status-down-text',
} as const

function SeriesTooltip({
  active,
  payload,
  format,
}: {
  active?: boolean
  payload?: ReadonlyArray<{ name?: unknown; value?: unknown; color?: string; payload?: Point }>
  format: (value: number) => string
}) {
  const formatter = useFormatter()
  const point = payload?.[0]?.payload
  if (!active || !point || !payload) return null
  const rows = payload.filter((item) => typeof item.value === 'number')
  if (rows.length === 0) return null
  return (
    <div className="rounded-md border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md">
      <div className="font-medium">{formatter.dateTime(new Date(point.t), 'short')}</div>
      <ul className="mt-1 flex flex-col gap-0.5">
        {rows.map((item) => (
          <li key={String(item.name)} className="flex items-center justify-between gap-4">
            <span className="flex items-center gap-1.5 text-muted-foreground">
              <span
                aria-hidden
                className="size-2 rounded-full"
                style={{ background: item.color }}
              />
              {String(item.name)}
            </span>
            <span className="tabular-nums">{format(item.value as number)}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function TrendCard({
  testId,
  title,
  description,
  empty,
  children,
}: {
  testId: string
  title: string
  description: string
  empty: boolean
  children: React.ReactElement
}) {
  const t = useTranslations('monitors.pagespeed')
  return (
    <Card className="gap-3" data-testid={testId}>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        {empty ? (
          <div className="flex h-56 items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground">
            {t('empty')}
          </div>
        ) : (
          <div className="h-56 w-full">
            <ResponsiveContainer width="100%" height="100%">
              {children}
            </ResponsiveContainer>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

/**
 * Trend charts of a PageSpeed monitor (#137) for the period the stats panel shows: the category
 * scores (with the monitor's minimums as dashed lines), the timing metrics and CLS.
 */
export function PagespeedTrendCharts({
  series,
  dailyTicks = false,
  thresholds = {},
}: {
  series: readonly PagespeedSeriesPoint[]
  /** Label the x axis with dates instead of times (periods longer than a day). */
  dailyTicks?: boolean
  thresholds?: Partial<Record<PagespeedCategory, number | null>>
}) {
  const t = useTranslations('monitors.pagespeed')
  const formatter = useFormatter()
  const format = useMonitorFormat()
  const data = React.useMemo(() => toPoints(series), [series])
  const domain: [number, number] = data.length > 0 ? [data[0].t, data[data.length - 1].t] : [0, 0]
  const has = (key: PagespeedSeriesKey) => data.some((point) => typeof point[key] === 'number')
  const categories = PAGESPEED_CATEGORIES.filter(has)
  const metrics = TIMING_METRICS.filter(has)
  const hasCls = has('cls')

  const xAxis = (
    <XAxis
      dataKey="t"
      type="number"
      domain={domain}
      scale="time"
      tickFormatter={(v: number) => formatter.dateTime(new Date(v), dailyTicks ? 'date' : 'time')}
      tick={{ fill: 'var(--muted-foreground)', fontSize: 11 }}
      axisLine={false}
      tickLine={false}
      minTickGap={48}
    />
  )
  const grid = <CartesianGrid vertical={false} stroke="var(--border)" strokeDasharray="3 3" />
  const legend = (
    <Legend
      verticalAlign="top"
      height={28}
      iconType="plainline"
      wrapperStyle={{ fontSize: 12, color: 'var(--muted-foreground)' }}
    />
  )
  const line = (key: PagespeedSeriesKey, name: string, color: string) => (
    <Line
      key={key}
      dataKey={key}
      name={name}
      type="monotone"
      stroke={color}
      strokeWidth={2}
      dot={false}
      activeDot={{ r: 4, strokeWidth: 2, stroke: 'var(--card)' }}
      connectNulls
      isAnimationActive={false}
    />
  )
  const yAxis = (tickFormatter: (v: number) => string, extra: Record<string, unknown> = {}) => (
    <YAxis
      width={56}
      tickFormatter={tickFormatter}
      tick={{ fill: 'var(--muted-foreground)', fontSize: 11 }}
      axisLine={false}
      tickLine={false}
      {...extra}
    />
  )
  const score = (v: number) => formatter.number(v, 'integer')
  const cls = (v: number) => formatter.number(v, 'metricValue')

  return (
    <div className="grid gap-6 lg:grid-cols-2" data-testid="pagespeed-trends">
      <div className="lg:col-span-2">
        <TrendCard
          testId="pagespeed-scores-chart"
          title={t('scoresTitle')}
          description={t('scoresDescription')}
          empty={categories.length === 0}
        >
          <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
            {grid}
            {xAxis}
            {yAxis(score, { domain: [0, 100], ticks: [0, 50, 90, 100] })}
            <Tooltip
              content={<SeriesTooltip format={score} />}
              cursor={{ stroke: 'var(--muted-foreground)', strokeWidth: 1 }}
            />
            {legend}
            {categories.map((category) => {
              const min = thresholds[category]
              return typeof min === 'number' ? (
                <ReferenceLine
                  key={`min-${category}`}
                  y={min}
                  stroke={CATEGORY_COLORS[category]}
                  strokeDasharray="4 3"
                  strokeOpacity={0.7}
                  ifOverflow="extendDomain"
                />
              ) : null
            })}
            {categories.map((category) =>
              line(category, t(`category.${category}`), CATEGORY_COLORS[category]),
            )}
          </LineChart>
        </TrendCard>
      </div>
      <TrendCard
        testId="pagespeed-metrics-chart"
        title={t('metricsTitle')}
        description={t('metricsDescription')}
        empty={metrics.length === 0}
      >
        <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          {grid}
          {xAxis}
          {yAxis((v) => format.ping(v))}
          <Tooltip
            content={<SeriesTooltip format={(v) => format.ping(v)} />}
            cursor={{ stroke: 'var(--muted-foreground)', strokeWidth: 1 }}
          />
          {legend}
          {metrics.map((metric) => line(metric, t(`metric.${metric}`), METRIC_COLORS[metric]))}
        </LineChart>
      </TrendCard>
      <TrendCard
        testId="pagespeed-cls-chart"
        title={t('clsTitle')}
        description={t('clsDescription')}
        empty={!hasCls}
      >
        <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          {grid}
          {xAxis}
          {yAxis(cls)}
          <Tooltip
            content={<SeriesTooltip format={cls} />}
            cursor={{ stroke: 'var(--muted-foreground)', strokeWidth: 1 }}
          />
          {legend}
          {line('cls', t('metric.cls'), 'var(--series-1)')}
        </LineChart>
      </TrendCard>
    </div>
  )
}

/** Scores, metrics and report link of the latest PageSpeed run (#137). */
export function PagespeedLatestCard({ run, time }: { run: PagespeedRun; time: string }) {
  const t = useTranslations('monitors.pagespeed')
  const formatter = useFormatter()
  const format = useMonitorFormat()
  const metricValue = (metric: PagespeedMetric, value: number) =>
    metric === 'cls' ? formatter.number(value, 'metricValue') : format.ping(value)
  const metrics = (['lcp', 'inp', 'cls', 'fcp', 'tbt', 'ttfb', 'si'] as const).filter(
    (metric) => typeof run.metrics[metric] === 'number',
  )
  return (
    <Card className="gap-3" data-testid="pagespeed-latest">
      <CardHeader>
        <CardTitle className="text-base">{t('latestTitle')}</CardTitle>
        <CardDescription>
          {t('latestDescription', {
            strategy: t(`strategy.${run.strategy}`),
            backend: t(`backend.${run.backend}`),
            time: formatter.dateTime(new Date(time), 'short'),
          })}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <ul className="grid grid-cols-2 gap-3">
          {PAGESPEED_CATEGORIES.filter((category) => typeof run.scores[category] === 'number').map(
            (category) => {
              const value = run.scores[category] as number
              return (
                <li
                  key={category}
                  className="flex items-center gap-3"
                  data-testid={`pagespeed-score-${category}`}
                >
                  <span
                    className={cn(
                      'flex size-10 shrink-0 items-center justify-center rounded-full border-2 text-sm font-semibold tabular-nums',
                      TONE_CLASS[scoreTone(value)],
                    )}
                  >
                    {formatter.number(value, 'integer')}
                  </span>
                  <span className="text-sm">{t(`category.${category}`)}</span>
                </li>
              )
            },
          )}
        </ul>
        {metrics.length > 0 && (
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
            {metrics.map((metric) => (
              <div key={metric} className="flex items-baseline justify-between gap-2">
                <dt className="text-muted-foreground">{t(`metric.${metric}`)}</dt>
                <dd className="tabular-nums">
                  {metricValue(metric, run.metrics[metric] as number)}
                </dd>
              </div>
            ))}
          </dl>
        )}
        {run.reportUrl && (
          <a
            href={run.reportUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 text-sm font-medium underline-offset-4 hover:underline"
            data-testid="pagespeed-report-link"
          >
            {t('fullReport')}
            <ExternalLink className="size-3.5" aria-hidden />
          </a>
        )}
      </CardContent>
    </Card>
  )
}
