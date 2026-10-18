'use client'

import { ArrowDown, ArrowUp, ChartLine, Plus, X } from 'lucide-react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import * as React from 'react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import type { MetricRow } from '@/lib/metrics'
import { metricsApi } from '@/lib/metrics-api'

import type { OrgId } from '../api'

export interface PageMetricsData {
  /** Every metric of the organization, in their own order. */
  metrics: MetricRow[]
  /** Ids of the metrics on the page, in its display order. */
  selected: string[]
}

/**
 * Metrics tab of the status page builder (#280): pick the organization's custom metrics this page
 * charts and their order. Saving lists the page on the picked metrics and stores the order on the
 * page; publishing a metric stays under Settings → Metrics.
 */
export function MetricsPanel({
  orgId,
  orgSlug,
  pageId,
  initial,
  canEdit,
}: {
  orgId: OrgId
  orgSlug: string
  pageId: OrgId
  /** Null when the member may not read metrics. */
  initial: PageMetricsData | null
  /** `metric:update` and `status-page:update`. */
  canEdit: boolean
}) {
  const t = useTranslations('statusPages.metricsPanel')
  const [metrics, setMetrics] = React.useState<MetricRow[]>(initial?.metrics ?? [])
  const [saved, setSaved] = React.useState<string[]>(initial?.selected ?? [])
  const [selected, setSelected] = React.useState<string[]>(initial?.selected ?? [])
  const [saving, setSaving] = React.useState(false)

  if (!initial) {
    return (
      <p className="rounded-xl border border-dashed px-5 py-8 text-center text-sm text-muted-foreground">
        {t('forbidden')}
      </p>
    )
  }

  const byId = new Map(metrics.map((metric) => [metric.id, metric]))
  const onPage = selected.flatMap((id) => byId.get(id) ?? [])
  const available = metrics.filter((metric) => !selected.includes(metric.id))
  const dirty = JSON.stringify(selected) !== JSON.stringify(saved)

  const move = (index: number, delta: number) =>
    setSelected((current) => {
      const next = [...current]
      const target = index + delta
      if (target < 0 || target >= next.length) return current
      ;[next[index], next[target]] = [next[target], next[index]]
      return next
    })

  async function save() {
    setSaving(true)
    try {
      const result = await metricsApi.setPageMetrics(orgId, pageId, selected)
      setMetrics(result.metrics)
      setSaved(result.selected)
      setSelected(result.selected)
      toast.success(t('saved'))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('saveFailed'))
    } finally {
      setSaving(false)
    }
  }

  const badges = (metric: MetricRow) => (
    <>
      <Badge variant="outline">{t(`sources.${metric.source}`)}</Badge>
      {!metric.visible && (
        <Badge variant="secondary" title={t('hiddenHint')}>
          {t('hidden')}
        </Badge>
      )}
    </>
  )

  return (
    <div className="flex max-w-3xl flex-col gap-6" data-testid="page-metrics-panel">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <Label className="text-base">{t('title')}</Label>
          <p className="text-sm text-muted-foreground">{t('description')}</p>
          {!canEdit && <p className="text-sm text-muted-foreground">{t('readOnly')}</p>}
        </div>
        <Button asChild variant="outline" size="sm">
          <Link href={`/${orgSlug}/settings/metrics`}>
            <ChartLine aria-hidden /> {t('manage')}
          </Link>
        </Button>
      </div>

      {metrics.length === 0 ? (
        <p className="rounded-xl border border-dashed px-5 py-8 text-center text-sm text-muted-foreground">
          {t('noMetrics')}
        </p>
      ) : (
        <>
          <section className="flex flex-col gap-2" aria-labelledby="page-metrics-on-page">
            <h3 id="page-metrics-on-page" className="text-sm font-medium">
              {t('onPage')}
            </h3>
            {onPage.length === 0 ? (
              <p className="rounded-xl border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
                {t('emptyOnPage')}
              </p>
            ) : (
              <ol className="divide-y rounded-xl border" data-testid="page-metrics-selected">
                {onPage.map((metric, index) => (
                  <li
                    key={metric.id}
                    className="flex items-center justify-between gap-3 px-3 py-2"
                    data-metric-id={metric.id}
                  >
                    <span className="flex min-w-0 flex-wrap items-center gap-2">
                      <span className="w-5 text-right text-xs text-muted-foreground tabular-nums">
                        {index + 1}
                      </span>
                      <span className="truncate font-medium">{metric.name}</span>
                      {badges(metric)}
                    </span>
                    <span className="flex shrink-0 gap-1">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label={t('moveUp', { name: metric.name })}
                        disabled={!canEdit || index === 0}
                        onClick={() => move(index, -1)}
                      >
                        <ArrowUp />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label={t('moveDown', { name: metric.name })}
                        disabled={!canEdit || index === onPage.length - 1}
                        onClick={() => move(index, 1)}
                      >
                        <ArrowDown />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label={t('remove', { name: metric.name })}
                        disabled={!canEdit}
                        onClick={() => setSelected(selected.filter((id) => id !== metric.id))}
                      >
                        <X />
                      </Button>
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </section>

          <section className="flex flex-col gap-2" aria-labelledby="page-metrics-available">
            <h3 id="page-metrics-available" className="text-sm font-medium">
              {t('available')}
            </h3>
            {available.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('emptyAvailable')}</p>
            ) : (
              <ul className="divide-y rounded-xl border" data-testid="page-metrics-available">
                {available.map((metric) => (
                  <li
                    key={metric.id}
                    className="flex items-center justify-between gap-3 px-3 py-2"
                    data-metric-id={metric.id}
                  >
                    <span className="flex min-w-0 flex-wrap items-center gap-2">
                      <span className="truncate">{metric.name}</span>
                      {badges(metric)}
                    </span>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      aria-label={t('add', { name: metric.name })}
                      disabled={!canEdit}
                      onClick={() => setSelected([...selected, metric.id])}
                    >
                      <Plus aria-hidden />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <div className="flex justify-end">
            <Button
              type="button"
              disabled={!canEdit || !dirty || saving}
              onClick={save}
              data-testid="page-metrics-save"
            >
              {saving ? t('saving') : t('save')}
            </Button>
          </div>
        </>
      )}
    </div>
  )
}
