'use client'

import { CircleAlert, CircleCheck, TriangleAlert } from 'lucide-react'
import { useFormatter, useTranslations } from 'next-intl'
import * as React from 'react'
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'

import { Button } from '@/components/ui/button'
import {
  METRIC_VIEWS,
  withMetricSuffix,
  type MetricThresholdState,
  type MetricView,
  type PublicMetric,
} from '@/lib/metrics'
import { cn } from '@/lib/utils'

/**
 * The single series of a metric chart: the darker step of the theme's chart ramp (validated for
 * both modes with the dataviz palette check, like the latency charts). Thresholds use the reserved
 * status colours and always carry a text label.
 */
const SERIES_COLOR = 'var(--chart-4)'
const THRESHOLD_COLOR = { warning: 'var(--status-degraded)', critical: 'var(--status-down)' }

/**
 * Headline value colouring by threshold state (#280): the reserved status text colours, always with
 * an icon and a text label so the state does not depend on colour alone.
 */
const STATE_STYLE: Record<MetricThresholdState, { className: string; Icon: typeof CircleCheck }> = {
  ok: { className: 'text-status-up-text', Icon: CircleCheck },
  warning: { className: 'text-status-degraded-text', Icon: TriangleAlert },
  critical: { className: 'text-status-down-text', Icon: CircleAlert },
}

const axisTick = { fill: 'var(--muted-foreground)', fontSize: 11 }

type ChartPoint = { t: number; value: number | null }

function useMetricValue(metric: Pick<PublicMetric, 'decimals' | 'suffix'>) {
  const t = useTranslations('statusPages.metrics')
  const format = useFormatter()
  return (value: number | null | undefined) =>
    value === null || value === undefined
      ? t('noValue')
      : withMetricSuffix(
          format.number(value, {
            minimumFractionDigits: metric.decimals,
            maximumFractionDigits: metric.decimals,
          }),
          metric.suffix,
        )
}

function MetricTooltip({
  active,
  payload,
  metric,
}: {
  active?: boolean
  payload?: ReadonlyArray<{ payload?: ChartPoint }>
  metric: PublicMetric
}) {
  const format = useFormatter()
  const show = useMetricValue(metric)
  const point = payload?.[0]?.payload
  if (!active || !point) return null
  return (
    <div className="rounded-md border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md">
      <div className="font-medium">{format.dateTime(new Date(point.t), 'short')}</div>
      <div className="mt-0.5 tabular-nums">{show(point.value)}</div>
    </div>
  )
}

/** One published metric: its headline value, period picker and chart. */
export function MetricCard({ slug, initial }: { slug: string; initial: PublicMetric }) {
  const t = useTranslations('statusPages.metrics')
  const format = useFormatter()
  const [metric, setMetric] = React.useState(initial)
  const [loading, setLoading] = React.useState(false)
  const [failed, setFailed] = React.useState(false)
  const show = useMetricValue(metric)

  const selectView = async (view: MetricView) => {
    if (view === metric.view || loading) return
    setLoading(true)
    setFailed(false)
    try {
      const query = new URLSearchParams({ metric: metric.id, view })
      const res = await fetch(`/api/status-pages/${encodeURIComponent(slug)}/metrics?${query}`, {
        headers: { Accept: 'application/json' },
      })
      if (!res.ok) throw new Error(String(res.status))
      const body = (await res.json()) as { metrics: PublicMetric[] }
      if (body.metrics[0]) setMetric(body.metrics[0])
    } catch {
      setFailed(true)
    } finally {
      setLoading(false)
    }
  }

  const points: ChartPoint[] = React.useMemo(
    () => metric.series.map((p) => ({ t: p.timestamp * 1000, value: p.value })),
    [metric.series],
  )
  const hasData = points.some((p) => p.value !== null)
  const tickFormat = metric.view === 'hour' || metric.view === 'day' ? 'time' : 'date'
  const domain: [number, number] =
    points.length > 0 ? [points[0].t, points[points.length - 1].t] : [0, 0]
  const thresholds = (['warning', 'critical'] as const).flatMap((level) => {
    const value = metric.thresholds[level]
    return value === null ? [] : [{ level, value }]
  })
  const headingId = `metric-${metric.id}`
  const state = metric.showThresholdState ? metric.state : null
  const stateStyle = state ? STATE_STYLE[state] : null

  return (
    <section
      className="flex flex-col gap-4 rounded-xl border bg-card px-4 py-5 shadow-sm sm:px-5"
      data-metric={metric.id}
      aria-labelledby={headingId}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 id={headingId} className="truncate text-base font-semibold tracking-tight">
            {metric.name}
          </h3>
          {metric.description && (
            <p className="text-sm text-muted-foreground">{metric.description}</p>
          )}
        </div>
        <div
          className="flex flex-col items-end"
          data-testid="metric-current"
          data-state={state ?? undefined}
        >
          <span
            className={cn(
              'text-2xl font-semibold tracking-tight tabular-nums',
              stateStyle?.className,
            )}
          >
            {show(metric.current)}
          </span>
          {state && stateStyle ? (
            <span
              className={cn(
                'inline-flex items-center gap-1 text-xs font-medium',
                stateStyle.className,
              )}
              data-testid="metric-state"
            >
              <stateStyle.Icon className="size-3.5" aria-hidden />
              {t(`states.${state}`)}
              <span className="font-normal text-muted-foreground">
                · {t(`aggregations.${metric.aggregation}`)}
              </span>
            </span>
          ) : (
            <span className="text-xs text-muted-foreground">
              {t(`aggregations.${metric.aggregation}`)}
            </span>
          )}
        </div>
      </div>

      <div role="group" aria-label={t('period')} className="flex flex-wrap gap-1.5">
        {METRIC_VIEWS.map((view) => (
          <Button
            key={view}
            type="button"
            size="sm"
            variant={metric.view === view ? 'default' : 'outline'}
            aria-pressed={metric.view === view}
            disabled={loading}
            onClick={() => void selectView(view)}
            data-testid={`metric-view-${view}`}
          >
            {t(`views.${view}`)}
          </Button>
        ))}
      </div>
      {failed && (
        <p role="alert" className="text-sm text-status-down-text">
          {t('loadFailed')}
        </p>
      )}

      {hasData ? (
        <div
          className="h-48 w-full"
          role="img"
          aria-busy={loading}
          aria-label={t('summary', {
            name: metric.name,
            period: t(`views.${metric.view}`),
            value: show(metric.summary),
          })}
        >
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={points} margin={{ top: 12, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid vertical={false} stroke="var(--border)" />
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
              <YAxis
                width={52}
                tickFormatter={(v: number) =>
                  format.number(v, { maximumFractionDigits: metric.decimals })
                }
                tick={axisTick}
                axisLine={false}
                tickLine={false}
              />
              <Tooltip
                content={<MetricTooltip metric={metric} />}
                cursor={{ stroke: 'var(--muted-foreground)', strokeWidth: 1 }}
              />
              {thresholds.map(({ level, value }) => (
                <ReferenceLine
                  key={level}
                  y={value}
                  stroke={THRESHOLD_COLOR[level]}
                  strokeDasharray="4 4"
                  ifOverflow="extendDomain"
                  label={{
                    value: t(`thresholds.${level}`, { value: show(value) }),
                    position: 'insideTopRight',
                    fill: 'var(--muted-foreground)',
                    fontSize: 11,
                  }}
                />
              ))}
              <Line
                dataKey="value"
                name={metric.name}
                type="monotone"
                stroke={SERIES_COLOR}
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4, strokeWidth: 2, stroke: 'var(--card)' }}
                connectNulls={false}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <div className="flex h-48 items-center justify-center rounded-lg border border-dashed px-4 text-center text-sm text-muted-foreground">
          {t('empty')}
        </div>
      )}
    </section>
  )
}

/** "Metrics" section of a status page (#155): one card per published metric. */
export function MetricsSection({ slug, metrics }: { slug: string; metrics: PublicMetric[] }) {
  const t = useTranslations('statusPages.metrics')
  if (metrics.length === 0) return null
  return (
    <section
      aria-labelledby="status-page-metrics"
      className="flex flex-col gap-4"
      data-testid="status-page-metrics"
    >
      <h2 id="status-page-metrics" className="text-lg font-semibold tracking-tight">
        {t('heading')}
      </h2>
      {metrics.map((metric) => (
        <MetricCard key={metric.id} slug={slug} initial={metric} />
      ))}
    </section>
  )
}
