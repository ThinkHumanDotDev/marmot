'use client'

import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  CircleSlash,
  FileBarChart,
  Gauge,
  Loader2,
  Pencil,
  Plus,
  Trash2,
  XCircle,
} from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
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
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import {
  isCalendarDate,
  isValidBusinessHours,
  normalizeThresholds,
  SLA_CALCULATIONS,
  SLA_MAX_ALERT_THRESHOLDS,
  SLA_SCHEDULES,
  SLA_SUBJECTS,
  SLA_TARGET_MAX,
  SLA_TARGET_MIN,
  SLA_WEEKDAYS,
  SLA_WINDOWS,
  type SlaBusinessHours,
  type SlaCalculation,
  type SlaHealth,
  type SlaSchedule,
  type SlaSubject,
  type SlaWeekday,
  type SlaWindow,
} from '@/lib/sla'
import { cn } from '@/lib/utils'
import type { TargetStatus } from '@/server/sla/compute'

import { slaApi, type SlaReportRowView, type StatusPageOption } from './sla-api'

export interface MonitorOption {
  id: string
  name: string
}

interface SlaDashboardProps {
  orgId: string
  orgSlug: string
  targets: TargetStatus[]
  reports: SlaReportRowView[]
  monitors: MonitorOption[]
  statusPages: StatusPageOption[]
  /** Notification channels for error budget alerts. */
  channels: MonitorOption[]
  /** `sla:manage`: create, edit and delete targets and reports. */
  canManage: boolean
}

export function SlaDashboard(props: SlaDashboardProps) {
  return (
    <div className="space-y-6">
      <TargetsCard {...props} />
      <ReportsCard {...props} />
    </div>
  )
}

// ---- Targets ----------------------------------------------------------------------------------------

const HEALTH_STYLE: Record<
  SlaHealth,
  { icon: typeof Gauge; text: string; fill: string; track: string }
> = {
  nodata: {
    icon: CircleSlash,
    text: 'text-muted-foreground',
    fill: 'bg-muted-foreground',
    track: 'bg-muted',
  },
  met: {
    icon: CheckCircle2,
    text: 'text-status-up-text',
    fill: 'bg-status-up',
    track: 'bg-status-up/20',
  },
  atRisk: {
    icon: AlertTriangle,
    text: 'text-status-degraded-text',
    fill: 'bg-status-degraded',
    track: 'bg-status-degraded/20',
  },
  missed: {
    icon: XCircle,
    text: 'text-status-down-text',
    fill: 'bg-status-down',
    track: 'bg-status-down/20',
  },
}

function HealthBadge({ health }: { health: SlaHealth }) {
  const t = useTranslations('sla.health')
  const style = HEALTH_STYLE[health]
  const Icon = style.icon
  return (
    <span className={cn('inline-flex items-center gap-1 text-sm font-medium', style.text)}>
      <Icon className="size-4" aria-hidden />
      {t(health)}
    </span>
  )
}

/** Remaining error budget as a meter: the fill carries the health, the track is its lighter step. */
function BudgetMeter({ status }: { status: TargetStatus }) {
  const t = useTranslations('sla.targets')
  const format = useFormatter()
  const ratio = status.attainment.remainingRatio
  const value = ratio === null ? 0 : Math.max(0, Math.min(1, ratio))
  const style = HEALTH_STYLE[status.health]
  const label = t('budgetMeter', {
    percent: ratio === null ? '—' : format.number(Math.max(0, ratio), 'wholePercent'),
  })
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(value * 100)}
      title={label}
      className={cn('h-2 w-full overflow-hidden rounded-full', style.track)}
    >
      <div className={cn('h-full rounded-full', style.fill)} style={{ width: `${value * 100}%` }} />
    </div>
  )
}

function TargetsCard({
  orgId,
  orgSlug,
  targets,
  monitors,
  statusPages,
  channels,
  canManage,
}: SlaDashboardProps) {
  const t = useTranslations('sla.targets')
  const router = useRouter()
  const [editing, setEditing] = React.useState<TargetStatus | 'new' | null>(null)
  const [deleting, setDeleting] = React.useState<TargetStatus | null>(null)

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <div className="space-y-1.5">
          <CardTitle>{t('title')}</CardTitle>
          <CardDescription>{t('description')}</CardDescription>
        </div>
        {canManage && (
          <Button size="sm" onClick={() => setEditing('new')} data-testid="sla-target-new">
            <Plus /> {t('new')}
          </Button>
        )}
      </CardHeader>
      <CardContent>
        {targets.length === 0 ? (
          <EmptyState icon={Gauge} title={t('emptyTitle')} description={t('emptyDescription')} />
        ) : (
          <ul className="divide-y rounded-lg border">
            {targets.map((status) => (
              <TargetItem
                key={status.id}
                status={status}
                orgSlug={orgSlug}
                canManage={canManage}
                onEdit={() => setEditing(status)}
                onDelete={() => setDeleting(status)}
              />
            ))}
          </ul>
        )}
      </CardContent>

      {canManage && (
        <Dialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
          <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
            <TargetForm
              orgId={orgId}
              target={editing === 'new' ? null : editing}
              monitors={monitors}
              statusPages={statusPages}
              channels={channels}
              onCancel={() => setEditing(null)}
              onSaved={() => {
                setEditing(null)
                router.refresh()
              }}
            />
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
            await slaApi.removeTarget(deleting.id)
            toast.success(t('deleted'))
            setDeleting(null)
            router.refresh()
          } catch (error) {
            toast.error(error instanceof Error ? error.message : t('deleteFailed'))
          }
        }}
      />
    </Card>
  )
}

function TargetItem({
  status,
  orgSlug,
  canManage,
  onEdit,
  onDelete,
}: {
  status: TargetStatus
  orgSlug: string
  canManage: boolean
  onEdit: () => void
  onDelete: () => void
}) {
  const t = useTranslations('sla')
  const format = useFormatter()
  const [open, setOpen] = React.useState(false)
  const { attainment } = status
  const minutes = (seconds: number) => format.number(Math.abs(seconds) / 60, 'minutes')
  const day = (date: string) => format.dateTime(new Date(`${date}T00:00:00Z`), 'utcDate')
  const businessHoursSummary = (hours: SlaBusinessHours) =>
    hours.days.map((weekday) => t(`weekdays.${weekday}`)).join(', ')

  return (
    <li className="space-y-3 px-4 py-3" data-sla-target={status.id}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate font-medium">{status.name}</span>
            <Badge variant="outline">{format.number(status.target / 100, 'targetPercent')}</Badge>
            <Badge variant="secondary">{t(`windows.${status.period}`)}</Badge>
            {status.subject !== 'monitor' && (
              <Badge variant="outline">{t(`subjects.${status.subject}`)}</Badge>
            )}
            {status.excludeMaintenance && (
              <Badge variant="outline">{t('targets.maintenanceExcluded')}</Badge>
            )}
            {status.budgetAlerts.thresholds.length > 0 &&
              status.budgetAlerts.notifications.length > 0 && (
                <Badge variant="outline" data-testid="sla-alerts-badge">
                  {t('targets.alerts', {
                    thresholds: status.budgetAlerts.thresholds
                      .map((threshold) => format.number(threshold / 100, 'wholePercent'))
                      .join(', '),
                  })}
                </Badge>
              )}
            {status.businessHours && (
              <Badge variant="outline" title={businessHoursSummary(status.businessHours)}>
                {t('targets.businessHours', {
                  start: status.businessHours.start,
                  end: status.businessHours.end,
                })}
              </Badge>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            {t('targets.period', { from: day(status.from), to: day(status.to) })}
            {' · '}
            {t('targets.periodElapsed', { percent: format.number(status.elapsed, 'wholePercent') })}
            {' · '}
            {t(`calculations.${status.calculation}`)}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <HealthBadge health={status.health} />
          {canManage && (
            <span className="flex gap-1">
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t('targets.editLabel', { name: status.name })}
                onClick={onEdit}
              >
                <Pencil />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t('targets.deleteLabel', { name: status.name })}
                onClick={onDelete}
              >
                <Trash2 />
              </Button>
            </span>
          )}
        </div>
      </div>

      <dl className="grid gap-3 text-sm sm:grid-cols-3">
        <div>
          <dt className="text-xs text-muted-foreground">{t('targets.attainment')}</dt>
          <dd className="text-lg font-semibold tabular-nums" data-testid="sla-attainment">
            {attainment.uptime === null ? '—' : format.number(attainment.uptime, 'slaPercent')}
          </dd>
        </div>
        <div className="space-y-1.5">
          <dt className="text-xs text-muted-foreground">{t('targets.budget')}</dt>
          <dd className="space-y-1.5">
            <BudgetMeter status={status} />
            <p className="text-xs tabular-nums" data-testid="sla-budget">
              {attainment.remainingSeconds >= 0
                ? t('targets.budgetLeft', {
                    remaining: minutes(attainment.remainingSeconds),
                    budget: minutes(attainment.budgetSeconds),
                  })
                : t('targets.budgetOver', {
                    over: minutes(attainment.remainingSeconds),
                    budget: minutes(attainment.budgetSeconds),
                  })}
            </p>
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground" title={t('targets.burnRateHint')}>
            {t('targets.burnRate')}
          </dt>
          <dd className="text-lg font-semibold tabular-nums">
            {attainment.burnRate === null ? '—' : format.number(attainment.burnRate, 'ratio')}
          </dd>
        </div>
      </dl>

      <div>
        <button
          type="button"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground disabled:pointer-events-none"
          aria-expanded={open}
          disabled={status.incidents.length === 0}
          onClick={() => setOpen((value) => !value)}
        >
          {status.incidents.length > 0 && (
            <ChevronDown className={cn('size-3.5 transition-transform', open && 'rotate-180')} />
          )}
          {t('targets.incidents', { count: status.incidents.length })}
        </button>
        {open && status.incidents.length > 0 && (
          <ul className="mt-2 space-y-1 text-sm" aria-label={t('targets.incidentsTitle')}>
            {status.incidents.map((incident) => (
              <li
                key={`${incident.source}:${incident.id}`}
                className="flex flex-wrap items-center gap-x-2"
              >
                <Link
                  href={
                    incident.source === 'statusPage'
                      ? `/${orgSlug}/status-pages/${incident.statusPageId}`
                      : `/${orgSlug}/incidents/${incident.id}`
                  }
                  className="font-medium underline-offset-4 hover:underline"
                >
                  {incident.cause || t('targets.incidentUnknownCause')}
                </Link>
                <span className="text-xs text-muted-foreground">
                  {format.dateTime(new Date(incident.startedAt), 'short')}
                  {' – '}
                  {incident.resolvedAt
                    ? format.dateTime(new Date(incident.resolvedAt), 'short')
                    : t('targets.incidentOpen')}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </li>
  )
}

function TargetForm({
  orgId,
  target,
  monitors,
  statusPages,
  channels,
  onCancel,
  onSaved,
}: {
  orgId: string
  target: TargetStatus | null
  monitors: MonitorOption[]
  statusPages: StatusPageOption[]
  channels: MonitorOption[]
  onCancel: () => void
  onSaved: () => void
}) {
  const t = useTranslations('sla')
  const [subject, setSubject] = React.useState<SlaSubject>(target?.subject ?? 'monitor')
  const [monitor, setMonitor] = React.useState(target?.monitorId ?? '')
  const [statusPage, setStatusPage] = React.useState(target?.statusPageId ?? '')
  const [component, setComponent] = React.useState(target?.component ?? '')
  const [thresholds, setThresholds] = React.useState(
    (target?.budgetAlerts.thresholds ?? []).join(', '),
  )
  const [alertChannels, setAlertChannels] = React.useState<Set<string>>(
    () => new Set(target?.budgetAlerts.notifications ?? []),
  )
  const page = statusPages.find((option) => option.id === statusPage)
  const pickable =
    subject === 'group'
      ? (page?.groups ?? []).map((group) => ({ id: group.id, name: group.name }))
      : (page?.groups ?? []).flatMap((group) =>
          group.components.map((c) => ({ id: c.id, name: `${group.name} › ${c.name}` })),
        )
  const [value, setValue] = React.useState(target ? String(target.target) : '99.9')
  const [period, setPeriod] = React.useState<SlaWindow>(target?.period ?? 'month')
  const [calculation, setCalculation] = React.useState<SlaCalculation>(
    target?.calculation ?? 'duration',
  )
  const [excludeMaintenance, setExcludeMaintenance] = React.useState(
    target?.excludeMaintenance ?? true,
  )
  const [useBusinessHours, setUseBusinessHours] = React.useState(target?.businessHours != null)
  const [days, setDays] = React.useState<Set<SlaWeekday>>(
    () => new Set(target?.businessHours?.days ?? ['mon', 'tue', 'wed', 'thu', 'fri']),
  )
  const [start, setStart] = React.useState(target?.businessHours?.start ?? '09:00')
  const [end, setEnd] = React.useState(target?.businessHours?.end ?? '17:00')
  const [holidays, setHolidays] = React.useState((target?.businessHours?.holidays ?? []).join('\n'))
  const [error, setError] = React.useState<string | null>(null)
  const [saving, setSaving] = React.useState(false)

  const toggleDay = (weekday: SlaWeekday, on: boolean) =>
    setDays((current) => {
      const next = new Set(current)
      if (on) next.add(weekday)
      else next.delete(weekday)
      return next
    })

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    const number = Number(value)
    if (subject === 'monitor' && !monitor) return setError(t('targets.form.monitorRequired'))
    if (subject !== 'monitor' && (!statusPage || !component)) {
      return setError(t('targets.form.componentRequired'))
    }
    const alertThresholds = thresholds
      .split(/[\s,;%]+/)
      .filter(Boolean)
      .map(Number)
    if (
      alertThresholds.length > SLA_MAX_ALERT_THRESHOLDS ||
      alertThresholds.some((n) => !Number.isFinite(n) || n < 0 || n > 100)
    ) {
      return setError(t('targets.form.thresholdsInvalid', { max: SLA_MAX_ALERT_THRESHOLDS }))
    }
    if (!Number.isFinite(number) || number < SLA_TARGET_MIN || number > SLA_TARGET_MAX) {
      return setError(t('targets.form.targetInvalid'))
    }
    let businessHours: SlaBusinessHours | null = null
    if (useBusinessHours) {
      const dates = holidays
        .split(/[\s,;]+/)
        .map((date) => date.trim())
        .filter(Boolean)
      if (dates.some((date) => !isCalendarDate(date))) {
        return setError(t('targets.form.holidaysInvalid'))
      }
      businessHours = {
        // Keep the week's order.
        days: SLA_WEEKDAYS.filter((weekday) => days.has(weekday)),
        start,
        end,
        holidays: dates,
      }
      if (!isValidBusinessHours(businessHours)) {
        return setError(t('targets.form.businessHoursInvalid'))
      }
    }
    setError(null)
    setSaving(true)
    try {
      const input = {
        subject,
        monitor: subject === 'monitor' ? monitor : null,
        statusPage: subject === 'monitor' ? null : statusPage,
        component: subject === 'monitor' ? null : component,
        budgetAlerts: {
          thresholds: normalizeThresholds(alertThresholds),
          notifications: channels.map((c) => c.id).filter((id) => alertChannels.has(id)),
        },
        target: number,
        period,
        calculation: subject === 'monitor' && calculation === 'manual' ? 'duration' : calculation,
        excludeMaintenance,
        businessHours,
      }
      if (target) await slaApi.updateTarget(target.id, input)
      else await slaApi.createTarget(orgId, input)
      toast.success(t('targets.form.saved'))
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('targets.form.saveFailed'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4" data-testid="sla-target-form">
      <DialogHeader>
        <DialogTitle>
          {target ? t('targets.form.editTitle') : t('targets.form.createTitle')}
        </DialogTitle>
        <DialogDescription>{t('targets.form.description')}</DialogDescription>
      </DialogHeader>
      <div className="space-y-2">
        <Label htmlFor="sla-subject">{t('targets.form.subject')}</Label>
        <Select
          value={subject}
          onValueChange={(next) => {
            setSubject(next as SlaSubject)
            setComponent('')
          }}
        >
          <SelectTrigger id="sla-subject" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SLA_SUBJECTS.map((option) => (
              <SelectItem key={option} value={option}>
                {t(`subjects.${option}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {subject === 'monitor' ? (
        <div className="space-y-2">
          <Label htmlFor="sla-monitor">{t('targets.form.monitor')}</Label>
          <Select value={monitor} onValueChange={setMonitor}>
            <SelectTrigger id="sla-monitor" className="w-full">
              <SelectValue placeholder={t('targets.form.monitorPlaceholder')} />
            </SelectTrigger>
            <SelectContent>
              {monitors.map((option) => (
                <SelectItem key={option.id} value={option.id}>
                  {option.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="sla-status-page">{t('targets.form.statusPage')}</Label>
            <Select
              value={statusPage}
              onValueChange={(next) => {
                setStatusPage(next)
                setComponent('')
              }}
            >
              <SelectTrigger id="sla-status-page" className="w-full">
                <SelectValue placeholder={t('targets.form.statusPagePlaceholder')} />
              </SelectTrigger>
              <SelectContent>
                {statusPages.map((option) => (
                  <SelectItem key={option.id} value={option.id}>
                    {option.title}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="sla-component">
              {subject === 'group' ? t('targets.form.group') : t('targets.form.component')}
            </Label>
            <Select value={component} onValueChange={setComponent} disabled={!page}>
              <SelectTrigger id="sla-component" className="w-full">
                <SelectValue placeholder={t('targets.form.componentPlaceholder')} />
              </SelectTrigger>
              <SelectContent>
                {pickable.map((option) => (
                  <SelectItem key={option.id} value={option.id}>
                    {option.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="sla-target">{t('targets.form.target')}</Label>
          <Input
            id="sla-target"
            inputMode="decimal"
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="sla-period">{t('targets.form.period')}</Label>
          <Select value={period} onValueChange={(next) => setPeriod(next as SlaWindow)}>
            <SelectTrigger id="sla-period" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SLA_WINDOWS.map((option) => (
                <SelectItem key={option} value={option}>
                  {t(`windows.${option}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">{t('targets.form.targetHint')}</p>
      <div className="space-y-2">
        <Label htmlFor="sla-calculation">{t('targets.form.calculation')}</Label>
        <Select
          value={calculation}
          onValueChange={(next) => setCalculation(next as SlaCalculation)}
        >
          <SelectTrigger id="sla-calculation" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SLA_CALCULATIONS.filter((option) => option !== 'manual' || subject !== 'monitor').map(
              (option) => (
                <SelectItem key={option} value={option}>
                  {t(`calculations.${option}`)}
                </SelectItem>
              ),
            )}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">{t('targets.form.calculationHint')}</p>
      </div>
      <div className="flex items-start justify-between gap-4 rounded-lg border p-3">
        <div className="space-y-0.5">
          <Label htmlFor="sla-maintenance">{t('targets.form.excludeMaintenance')}</Label>
          <p className="text-xs text-muted-foreground">
            {t('targets.form.excludeMaintenanceHint')}
          </p>
        </div>
        <Switch
          id="sla-maintenance"
          checked={excludeMaintenance}
          onCheckedChange={setExcludeMaintenance}
        />
      </div>
      <div className="space-y-3 rounded-lg border p-3">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-0.5">
            <Label htmlFor="sla-business-hours">{t('targets.form.businessHours')}</Label>
            <p className="text-xs text-muted-foreground">{t('targets.form.businessHoursHint')}</p>
          </div>
          <Switch
            id="sla-business-hours"
            checked={useBusinessHours}
            onCheckedChange={setUseBusinessHours}
          />
        </div>
        {useBusinessHours && (
          <>
            <fieldset className="space-y-1.5">
              <legend className="text-sm font-medium">{t('targets.form.businessDays')}</legend>
              <div className="flex flex-wrap gap-x-3 gap-y-1">
                {SLA_WEEKDAYS.map((weekday) => (
                  <label key={weekday} className="flex items-center gap-1.5 text-sm">
                    <input
                      type="checkbox"
                      className="size-4 accent-primary"
                      checked={days.has(weekday)}
                      onChange={(event) => toggleDay(weekday, event.target.checked)}
                    />
                    {t(`weekdays.${weekday}`)}
                  </label>
                ))}
              </div>
            </fieldset>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="sla-business-start">{t('targets.form.businessStart')}</Label>
                <Input
                  id="sla-business-start"
                  value={start}
                  placeholder="09:00"
                  onChange={(event) => setStart(event.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="sla-business-end">{t('targets.form.businessEnd')}</Label>
                <Input
                  id="sla-business-end"
                  value={end}
                  placeholder="17:00"
                  onChange={(event) => setEnd(event.target.value)}
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="sla-holidays">{t('targets.form.holidays')}</Label>
              <Textarea
                id="sla-holidays"
                rows={2}
                value={holidays}
                placeholder="2026-12-25"
                onChange={(event) => setHolidays(event.target.value)}
              />
              <p className="text-xs text-muted-foreground">{t('targets.form.holidaysHint')}</p>
            </div>
          </>
        )}
      </div>
      <fieldset className="space-y-3 rounded-lg border p-3">
        <legend className="px-1 text-sm font-medium">{t('targets.form.alerts')}</legend>
        <p className="text-xs text-muted-foreground">{t('targets.form.alertsHint')}</p>
        <div className="space-y-2">
          <Label htmlFor="sla-thresholds">{t('targets.form.thresholds')}</Label>
          <Input
            id="sla-thresholds"
            value={thresholds}
            placeholder="50, 25, 10"
            onChange={(event) => setThresholds(event.target.value)}
          />
        </div>
        {channels.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t('targets.form.noChannels')}</p>
        ) : (
          <ul
            className="max-h-36 space-y-1 overflow-y-auto"
            aria-label={t('targets.form.channels')}
          >
            {channels.map((channel) => (
              <li key={channel.id}>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="size-4 accent-primary"
                    checked={alertChannels.has(channel.id)}
                    onChange={(event) =>
                      setAlertChannels((current) => {
                        const next = new Set(current)
                        if (event.target.checked) next.add(channel.id)
                        else next.delete(channel.id)
                        return next
                      })
                    }
                  />
                  {channel.name}
                </label>
              </li>
            ))}
          </ul>
        )}
      </fieldset>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel}>
          {t('targets.form.cancel')}
        </Button>
        <Button type="submit" disabled={saving}>
          {saving && <Loader2 className="animate-spin" />}
          {t('targets.form.save')}
        </Button>
      </DialogFooter>
    </form>
  )
}

// ---- Reports ----------------------------------------------------------------------------------------

function ReportsCard({ orgId, orgSlug, targets, reports, canManage }: SlaDashboardProps) {
  const t = useTranslations('sla')
  const format = useFormatter()
  const router = useRouter()
  const [editing, setEditing] = React.useState<SlaReportRowView | 'new' | null>(null)
  const [deleting, setDeleting] = React.useState<SlaReportRowView | null>(null)

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <div className="space-y-1.5">
          <CardTitle>{t('reports.title')}</CardTitle>
          <CardDescription>{t('reports.description')}</CardDescription>
        </div>
        {canManage && (
          <Button size="sm" onClick={() => setEditing('new')} data-testid="sla-report-new">
            <Plus /> {t('reports.new')}
          </Button>
        )}
      </CardHeader>
      <CardContent>
        {reports.length === 0 ? (
          <EmptyState
            icon={FileBarChart}
            title={t('reports.emptyTitle')}
            description={t('reports.emptyDescription')}
          />
        ) : (
          <ul className="divide-y rounded-lg border">
            {reports.map((report) => (
              <li
                key={report.id}
                data-sla-report={report.id}
                className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
              >
                <div className="min-w-0 flex-1 space-y-0.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link
                      href={`/${orgSlug}/sla/reports/${report.id}`}
                      className="truncate font-medium underline-offset-4 hover:underline"
                    >
                      {report.name}
                    </Link>
                    <Badge variant="secondary">{t(`schedules.${report.schedule}`)}</Badge>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {t('reports.targetCount', { count: report.targetIds.length })}
                    {report.schedule !== 'none' &&
                      ` · ${t('reports.recipientCount', { count: report.recipients.length })}`}
                    {report.lastSentAt &&
                      ` · ${t('reports.lastSent', { date: format.dateTime(new Date(report.lastSentAt), 'short') })}`}
                  </p>
                  {report.lastError && (
                    <p className="text-xs text-destructive">
                      {t('reports.lastError', { error: report.lastError })}
                    </p>
                  )}
                </div>
                <span className="flex items-center gap-1">
                  <Button variant="outline" size="sm" asChild>
                    <Link href={`/${orgSlug}/sla/reports/${report.id}`}>{t('reports.open')}</Link>
                  </Button>
                  {canManage && (
                    <>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={t('reports.editLabel', { name: report.name })}
                        onClick={() => setEditing(report)}
                      >
                        <Pencil />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={t('reports.deleteLabel', { name: report.name })}
                        onClick={() => setDeleting(report)}
                      >
                        <Trash2 />
                      </Button>
                    </>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>

      {canManage && (
        <Dialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
          <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
            <ReportForm
              orgId={orgId}
              report={editing === 'new' ? null : editing}
              targets={targets}
              onCancel={() => setEditing(null)}
              onSaved={() => {
                setEditing(null)
                router.refresh()
              }}
            />
          </DialogContent>
        </Dialog>
      )}

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={t('reports.confirmDeleteTitle', { name: deleting?.name ?? '' })}
        description={t('reports.confirmDeleteDescription')}
        confirmLabel={t('reports.confirmDelete')}
        destructive
        onConfirm={async () => {
          if (!deleting) return
          try {
            await slaApi.removeReport(deleting.id)
            toast.success(t('reports.deleted'))
            setDeleting(null)
            router.refresh()
          } catch (error) {
            toast.error(error instanceof Error ? error.message : t('reports.deleteFailed'))
          }
        }}
      />
    </Card>
  )
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function ReportForm({
  orgId,
  report,
  targets,
  onCancel,
  onSaved,
}: {
  orgId: string
  report: SlaReportRowView | null
  targets: TargetStatus[]
  onCancel: () => void
  onSaved: () => void
}) {
  const t = useTranslations('sla')
  const format = useFormatter()
  const [name, setName] = React.useState(report?.name ?? '')
  const [selected, setSelected] = React.useState<Set<string>>(
    () => new Set(report?.targetIds ?? targets.map((target) => target.id)),
  )
  const [schedule, setSchedule] = React.useState<SlaSchedule>(report?.schedule ?? 'monthly')
  const [recipients, setRecipients] = React.useState((report?.recipients ?? []).join('\n'))
  const [error, setError] = React.useState<string | null>(null)
  const [saving, setSaving] = React.useState(false)

  const toggle = (id: string, on: boolean) =>
    setSelected((current) => {
      const next = new Set(current)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    const emails = recipients
      .split(/[\s,;]+/)
      .map((value) => value.trim())
      .filter(Boolean)
    if (!name.trim()) return setError(t('reports.form.nameRequired'))
    if (emails.some((email) => !EMAIL_RE.test(email))) {
      return setError(t('reports.form.recipientsInvalid'))
    }
    setError(null)
    setSaving(true)
    try {
      const input = {
        name: name.trim(),
        // Keep the targets' order of the page.
        targets: targets.map((target) => target.id).filter((id) => selected.has(id)),
        schedule,
        recipients: emails,
      }
      if (report) await slaApi.updateReport(report.id, input)
      else await slaApi.createReport(orgId, input)
      toast.success(t('reports.form.saved'))
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('reports.form.saveFailed'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4" data-testid="sla-report-form">
      <DialogHeader>
        <DialogTitle>
          {report ? t('reports.form.editTitle') : t('reports.form.createTitle')}
        </DialogTitle>
        <DialogDescription>{t('reports.form.description')}</DialogDescription>
      </DialogHeader>
      <div className="space-y-2">
        <Label htmlFor="sla-report-name">{t('reports.form.name')}</Label>
        <Input
          id="sla-report-name"
          value={name}
          maxLength={100}
          placeholder={t('reports.form.namePlaceholder')}
          onChange={(event) => setName(event.target.value)}
        />
      </div>
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">{t('reports.form.targets')}</legend>
        {targets.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('reports.form.noTargets')}</p>
        ) : (
          <ul className="max-h-48 space-y-1 overflow-y-auto rounded-lg border p-2">
            {targets.map((target) => (
              <li key={target.id}>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="size-4 accent-primary"
                    checked={selected.has(target.id)}
                    onChange={(event) => toggle(target.id, event.target.checked)}
                  />
                  <span className="truncate">{target.name}</span>
                  <span className="text-xs text-muted-foreground">
                    {format.number(target.target / 100, 'targetPercent')}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )}
      </fieldset>
      <div className="space-y-2">
        <Label htmlFor="sla-report-schedule">{t('reports.form.schedule')}</Label>
        <Select value={schedule} onValueChange={(next) => setSchedule(next as SlaSchedule)}>
          <SelectTrigger id="sla-report-schedule" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SLA_SCHEDULES.map((option) => (
              <SelectItem key={option} value={option}>
                {t(`schedules.${option}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">{t('reports.form.scheduleHint')}</p>
      </div>
      {schedule !== 'none' && (
        <div className="space-y-2">
          <Label htmlFor="sla-report-recipients">{t('reports.form.recipients')}</Label>
          <Textarea
            id="sla-report-recipients"
            rows={3}
            value={recipients}
            placeholder="ops@example.com"
            onChange={(event) => setRecipients(event.target.value)}
          />
          <p className="text-xs text-muted-foreground">{t('reports.form.recipientsHint')}</p>
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel}>
          {t('reports.form.cancel')}
        </Button>
        <Button type="submit" disabled={saving}>
          {saving && <Loader2 className="animate-spin" />}
          {t('reports.form.save')}
        </Button>
      </DialogFooter>
    </form>
  )
}
