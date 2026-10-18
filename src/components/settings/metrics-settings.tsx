'use client'

import { ChartLine, Loader2, Pencil, Plus, Trash2 } from 'lucide-react'
import { useFormatter, useTranslations } from 'next-intl'
import * as React from 'react'
import { toast } from 'sonner'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { EmptyState } from '@/components/empty-state'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import {
  DEFAULT_METRIC_VIEW,
  METRIC_AGGREGATIONS,
  METRIC_MAX_DECIMALS,
  METRIC_SOURCES,
  METRIC_VIEWS,
  withMetricSuffix,
  type MetricRow,
} from '@/lib/metrics'
import { metricsApi, type MetricInput } from '@/lib/metrics-api'

import { SwitchRow } from './proxies-settings'

interface Option {
  id: string
  name: string
}

interface MetricsSettingsProps {
  orgId: string
  initial: MetricRow[]
  monitors: Option[]
  statusPages: Option[]
  /** `metric:update` — create, edit and delete. */
  canManage: boolean
}

const sortRows = (rows: MetricRow[]) =>
  [...rows].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))

/** Settings → Metrics (#155): custom metrics and the status pages that publish them. */
export function MetricsSettings({
  orgId,
  initial,
  monitors,
  statusPages,
  canManage,
}: MetricsSettingsProps) {
  const t = useTranslations('settings.metrics')
  const format = useFormatter()
  const [rows, setRows] = React.useState<MetricRow[]>(() => sortRows(initial))
  const [editing, setEditing] = React.useState<MetricRow | 'new' | null>(null)
  const [deleting, setDeleting] = React.useState<MetricRow | null>(null)

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <div className="space-y-1.5">
          <CardTitle>{t('title')}</CardTitle>
          <CardDescription>{t('description')}</CardDescription>
        </div>
        {canManage && (
          <Button size="sm" onClick={() => setEditing('new')} data-testid="metric-new">
            <Plus /> {t('new')}
          </Button>
        )}
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <EmptyState
            icon={ChartLine}
            title={t('emptyTitle')}
            description={canManage ? t('emptyDescription') : t('emptyReadOnly')}
          />
        ) : (
          <ul className="divide-y rounded-lg border">
            {rows.map((row) => (
              <li key={row.id} className="flex items-start justify-between gap-3 px-3 py-2">
                <div className="min-w-0 flex-1 space-y-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{row.name}</span>
                    <Badge variant="outline">{t(`sources.${row.source}`)}</Badge>
                    {row.visible && row.statusPages.length > 0 ? (
                      <Badge variant="secondary">
                        {t('badgePublished', { count: row.statusPages.length })}
                      </Badge>
                    ) : (
                      <Badge variant="outline">{t('badgeHidden')}</Badge>
                    )}
                  </span>
                  <p className="text-xs text-muted-foreground">
                    {row.lastPushAt && row.lastValue !== null
                      ? t('lastValue', {
                          value: withMetricSuffix(
                            format.number(row.lastValue, {
                              maximumFractionDigits: row.decimals,
                            }),
                            row.suffix,
                          ),
                          time: format.dateTime(new Date(row.lastPushAt), 'short'),
                        })
                      : row.source === 'push'
                        ? t('neverPushed')
                        : t('monitorBacked')}
                  </p>
                  {row.source === 'push' && (
                    <code className="block truncate rounded bg-muted px-2 py-1 font-mono text-xs">
                      {`POST /api/orgs/${orgId}/metrics/${row.id}/points`}
                    </code>
                  )}
                </div>
                {canManage && (
                  <span className="flex gap-1">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t('editLabel', { name: row.name })}
                      onClick={() => setEditing(row)}
                    >
                      <Pencil />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t('deleteLabel', { name: row.name })}
                      onClick={() => setDeleting(row)}
                    >
                      <Trash2 />
                    </Button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
        <p className="mt-3 text-sm text-muted-foreground">{t('pushHint')}</p>
      </CardContent>

      {canManage && (
        <Dialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
          <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
            {editing !== null && (
              <MetricForm
                orgId={orgId}
                metric={editing === 'new' ? null : editing}
                monitors={monitors}
                statusPages={statusPages}
                onCancel={() => setEditing(null)}
                onSaved={(row) => {
                  setRows((current) => sortRows([...current.filter((r) => r.id !== row.id), row]))
                  setEditing(null)
                }}
              />
            )}
          </DialogContent>
        </Dialog>
      )}

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={t('confirmDeleteTitle', { name: deleting?.name ?? '' })}
        description={t('confirmDeleteDescription')}
        confirmLabel={t('confirmDelete')}
        destructive
        onConfirm={async () => {
          if (!deleting) return
          try {
            await metricsApi.remove(orgId, deleting.id)
            setRows((current) => current.filter((r) => r.id !== deleting.id))
            toast.success(t('deleted'))
            setDeleting(null)
          } catch (error) {
            toast.error(error instanceof Error ? error.message : t('deleteFailed'))
          }
        }}
      />
    </Card>
  )
}

const numberOrNull = (value: string): number | null => {
  if (value.trim() === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function MetricForm({
  orgId,
  metric,
  monitors,
  statusPages,
  onCancel,
  onSaved,
}: {
  orgId: string
  metric: MetricRow | null
  monitors: Option[]
  statusPages: Option[]
  onCancel: () => void
  onSaved: (row: MetricRow) => void
}) {
  const t = useTranslations('settings.metrics.form')
  const tm = useTranslations('settings.metrics')
  const [form, setForm] = React.useState({
    name: metric?.name ?? '',
    description: metric?.description ?? '',
    suffix: metric?.suffix ?? '',
    decimals: String(metric?.decimals ?? 0),
    aggregation: metric?.aggregation ?? 'average',
    defaultView: metric?.defaultView ?? DEFAULT_METRIC_VIEW,
    warning: metric?.thresholds.warning?.toString() ?? '',
    critical: metric?.thresholds.critical?.toString() ?? '',
    showThresholdState: metric?.showThresholdState ?? false,
    source: metric?.source ?? 'push',
    monitor: metric?.monitor ?? '',
    visible: metric?.visible ?? false,
    statusPages: metric?.statusPages ?? [],
    order: String(metric?.order ?? 0),
  })
  const [saving, setSaving] = React.useState(false)
  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) =>
    setForm((current) => ({ ...current, [key]: value }))

  const canSave =
    form.name.trim().length > 0 && (form.source === 'push' || form.monitor !== '') && !saving

  async function save(event: React.FormEvent) {
    event.preventDefault()
    if (!canSave) return
    setSaving(true)
    try {
      const data: MetricInput = {
        name: form.name.trim(),
        description: form.description.trim() || null,
        suffix: form.suffix.trim() || null,
        decimals: Math.min(
          METRIC_MAX_DECIMALS,
          Math.max(0, Math.round(Number(form.decimals) || 0)),
        ),
        aggregation: form.aggregation,
        defaultView: form.defaultView,
        thresholds: { warning: numberOrNull(form.warning), critical: numberOrNull(form.critical) },
        showThresholdState: form.showThresholdState,
        source: form.source,
        monitor: form.source === 'monitor' ? form.monitor : null,
        visible: form.visible,
        statusPages: form.statusPages,
        order: Math.round(Number(form.order) || 0),
      }
      const { doc } = metric
        ? await metricsApi.update(orgId, metric.id, data)
        : await metricsApi.create(orgId, data)
      toast.success(metric ? t('saved') : t('created'))
      onSaved(doc)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('failed'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={save} className="grid gap-4">
      <DialogHeader>
        <DialogTitle>{metric ? t('editTitle') : t('newTitle')}</DialogTitle>
        <DialogDescription>{t('description')}</DialogDescription>
      </DialogHeader>
      <div className="grid gap-2">
        <Label htmlFor="metric-name">{t('name')}</Label>
        <Input
          id="metric-name"
          value={form.name}
          maxLength={100}
          placeholder={t('namePlaceholder')}
          autoComplete="off"
          onChange={(e) => set('name', e.target.value)}
        />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="metric-description">{t('descriptionLabel')}</Label>
        <Textarea
          id="metric-description"
          value={form.description}
          maxLength={500}
          rows={2}
          onChange={(e) => set('description', e.target.value)}
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="grid gap-2">
          <Label htmlFor="metric-suffix">{t('suffix')}</Label>
          <Input
            id="metric-suffix"
            value={form.suffix}
            maxLength={16}
            placeholder={t('suffixPlaceholder')}
            onChange={(e) => set('suffix', e.target.value)}
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="metric-decimals">{t('decimals')}</Label>
          <Input
            id="metric-decimals"
            type="number"
            min={0}
            max={METRIC_MAX_DECIMALS}
            value={form.decimals}
            onChange={(e) => set('decimals', e.target.value)}
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="metric-aggregation">{t('aggregation')}</Label>
          <Select
            value={form.aggregation}
            onValueChange={(v) => set('aggregation', v as typeof form.aggregation)}
          >
            <SelectTrigger id="metric-aggregation" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {METRIC_AGGREGATIONS.map((value) => (
                <SelectItem key={value} value={value}>
                  {tm(`aggregations.${value}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-2">
          <Label htmlFor="metric-view">{t('defaultView')}</Label>
          <Select
            value={form.defaultView}
            onValueChange={(v) => set('defaultView', v as typeof form.defaultView)}
          >
            <SelectTrigger id="metric-view" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {METRIC_VIEWS.map((value) => (
                <SelectItem key={value} value={value}>
                  {tm(`views.${value}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-2">
          <Label htmlFor="metric-warning">{t('warning')}</Label>
          <Input
            id="metric-warning"
            type="number"
            step="any"
            value={form.warning}
            onChange={(e) => set('warning', e.target.value)}
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="metric-critical">{t('critical')}</Label>
          <Input
            id="metric-critical"
            type="number"
            step="any"
            value={form.critical}
            onChange={(e) => set('critical', e.target.value)}
          />
        </div>
      </div>
      <SwitchRow
        id="metric-threshold-state"
        label={t('showThresholdState')}
        description={t('showThresholdStateHint')}
        checked={form.showThresholdState}
        onChange={(v) => set('showThresholdState', v)}
      />
      <div className="grid gap-2">
        <Label htmlFor="metric-source">{t('source')}</Label>
        <Select value={form.source} onValueChange={(v) => set('source', v as typeof form.source)}>
          <SelectTrigger id="metric-source" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {METRIC_SOURCES.map((value) => (
              <SelectItem key={value} value={value}>
                {tm(`sources.${value}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-sm text-muted-foreground">{t('sourceHint')}</p>
      </div>
      {form.source === 'monitor' && (
        <div className="grid gap-2">
          <Label htmlFor="metric-monitor">{t('monitor')}</Label>
          <Select value={form.monitor} onValueChange={(v) => set('monitor', v)}>
            <SelectTrigger id="metric-monitor" className="w-full">
              <SelectValue placeholder={t('monitorPlaceholder')} />
            </SelectTrigger>
            <SelectContent>
              {monitors.map((monitor) => (
                <SelectItem key={monitor.id} value={monitor.id}>
                  {monitor.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
      <SwitchRow
        id="metric-visible"
        label={t('visible')}
        description={t('visibleHint')}
        checked={form.visible}
        onChange={(v) => set('visible', v)}
      />
      {statusPages.length > 0 && (
        <fieldset className="grid gap-2">
          <legend className="mb-2 text-sm font-medium">{t('statusPages')}</legend>
          {statusPages.map((page) => (
            <SwitchRow
              key={page.id}
              id={`metric-page-${page.id}`}
              label={page.name}
              checked={form.statusPages.includes(page.id)}
              onChange={(on) =>
                set(
                  'statusPages',
                  on
                    ? [...form.statusPages, page.id]
                    : form.statusPages.filter((id) => id !== page.id),
                )
              }
            />
          ))}
        </fieldset>
      )}
      <div className="grid gap-2">
        <Label htmlFor="metric-order">{t('order')}</Label>
        <Input
          id="metric-order"
          type="number"
          value={form.order}
          onChange={(e) => set('order', e.target.value)}
        />
      </div>
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onCancel}>
          {t('cancel')}
        </Button>
        <Button type="submit" disabled={!canSave} data-testid="metric-save">
          {saving && <Loader2 className="animate-spin" />}
          {metric ? t('save') : t('create')}
        </Button>
      </DialogFooter>
    </form>
  )
}
