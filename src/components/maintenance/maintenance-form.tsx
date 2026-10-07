'use client'

import { zodResolver } from '@hookform/resolvers/zod'
import { Cron } from 'croner'
import { Loader2 } from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useFormatter, useTranslations } from 'next-intl'
import * as React from 'react'
import { useForm, useWatch, type Control, type FieldPath } from 'react-hook-form'
import { toast } from 'sonner'

import { TimezoneSelect } from '@/components/settings/timezone-select'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { ApiError } from '@/lib/api'
import { cn } from '@/lib/utils'
import { timeZoneOrDefault } from '@/i18n/formats'
import {
  createMaintenanceFormSchema,
  hasSchedule,
  isRecurringStrategy,
  LAST_DAY_VALUES,
  MAINTENANCE_STRATEGIES,
  MAX_DURATION_MINUTES,
  MAX_INTERVAL_DAYS,
  SAME_AS_SERVER,
  toDateTimeLocal,
  WEEKDAY_ORDER,
  type DayOfMonthValue,
  type MaintenanceFormInput,
  type MaintenanceFormValues,
  type MaintenanceStrategy,
  type WeekdayValue,
} from '@/lib/validation/maintenance'

import { PickerList } from './picker-list'
import { maintenanceApi, type MonitorOption, type StatusPageOption } from './types'

export interface MaintenanceFormProps {
  mode: 'create' | 'edit'
  orgId: string | number
  orgSlug: string
  maintenanceId?: string
  initialValues: MaintenanceFormValues
  monitors: MonitorOption[]
  statusPages: StatusPageOption[]
  /** The organization's timezone, used for the "Organization default" label. */
  orgTimezone: string
}

type Name = FieldPath<MaintenanceFormInput>
type FormControlType = Control<MaintenanceFormInput, unknown, MaintenanceFormValues>

/** Quick end presets for single windows, in minutes (under an hour shown in minutes). */
const QUICK_DURATIONS = [15, 30, 60, 120, 240, 480, 720, 1440]

// ---- Field helpers ------------------------------------------------------------------------------

function TextInputField({
  control,
  name,
  label,
  description,
  type = 'text',
  placeholder,
  mono,
}: {
  control: FormControlType
  name: Name
  label: string
  description?: React.ReactNode
  type?: string
  placeholder?: string
  mono?: boolean
}) {
  return (
    <FormField
      control={control}
      name={name}
      render={({ field }) => (
        <FormItem>
          <FormLabel>{label}</FormLabel>
          <FormControl>
            <Input
              type={type}
              placeholder={placeholder}
              className={mono ? 'font-mono' : undefined}
              {...field}
              value={(field.value as string | null | undefined) ?? ''}
            />
          </FormControl>
          {description && <FormDescription>{description}</FormDescription>}
          <FormMessage />
        </FormItem>
      )}
    />
  )
}

function NumberInputField({
  control,
  name,
  label,
  description,
  min,
  max,
  unit,
}: {
  control: FormControlType
  name: Name
  label: string
  description?: React.ReactNode
  min?: number
  max?: number
  unit?: string
}) {
  return (
    <FormField
      control={control}
      name={name}
      render={({ field }) => (
        <FormItem>
          <FormLabel>{label}</FormLabel>
          <FormControl>
            <div className="relative">
              <Input
                type="number"
                inputMode="numeric"
                min={min}
                max={max}
                step={1}
                name={field.name}
                ref={field.ref}
                onBlur={field.onBlur}
                value={
                  typeof field.value === 'number' && Number.isFinite(field.value) ? field.value : ''
                }
                onChange={(e) =>
                  field.onChange(e.target.value === '' ? undefined : Number(e.target.value))
                }
                className={unit ? 'pr-16' : undefined}
              />
              {unit && (
                <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-muted-foreground">
                  {unit}
                </span>
              )}
            </div>
          </FormControl>
          {description && <FormDescription>{description}</FormDescription>}
          <FormMessage />
        </FormItem>
      )}
    />
  )
}

/** Toggle-button group bound to an array field (weekdays, days of month). */
function ToggleGroupField<T extends string>({
  control,
  name,
  label,
  description,
  options,
  columns,
}: {
  control: FormControlType
  name: Name
  label: string
  description?: React.ReactNode
  options: { value: T; label: string }[]
  columns?: string
}) {
  return (
    <FormField
      control={control}
      name={name}
      render={({ field }) => {
        const current = (field.value as T[] | undefined) ?? []
        const toggle = (value: T) =>
          field.onChange(
            current.includes(value)
              ? current.filter((v) => v !== value)
              : options
                  .filter((o) => o.value === value || current.includes(o.value))
                  .map((o) => o.value),
          )
        return (
          <FormItem>
            <FormLabel>{label}</FormLabel>
            <FormControl>
              <div role="group" aria-label={label} className={cn('grid gap-1.5', columns)}>
                {options.map((option) => {
                  const on = current.includes(option.value)
                  return (
                    <Button
                      key={option.value}
                      type="button"
                      size="sm"
                      variant={on ? 'default' : 'outline'}
                      aria-pressed={on}
                      onClick={() => toggle(option.value)}
                    >
                      {option.label}
                    </Button>
                  )
                })}
              </div>
            </FormControl>
            {description && <FormDescription>{description}</FormDescription>}
            <FormMessage />
          </FormItem>
        )
      }}
    />
  )
}

/**
 * Next matches of a cron expression, for a quick sanity check while typing. `SAME_AS_SERVER`
 * runs in the organization's zone, as on the server (`getOrganizationTimezone`).
 */
function cronPreview(pattern: string, timezone: string, orgTimezone: string): Date[] | null {
  try {
    const zone = timezone === SAME_AS_SERVER ? orgTimezone : timezone
    return new Cron(pattern, { timezone: zone }).nextRuns(3)
  } catch {
    return null
  }
}

// ---- Form -----------------------------------------------------------------------------------------

export function MaintenanceForm({
  mode,
  orgId,
  orgSlug,
  maintenanceId,
  initialValues,
  monitors,
  statusPages,
  orgTimezone,
}: MaintenanceFormProps) {
  const t = useTranslations('maintenance.form')
  const tv = useTranslations('maintenance.validation')
  const tStrategy = useTranslations('maintenance.strategies')
  const tHelp = useTranslations('maintenance.strategyHelp')
  const tWeekday = useTranslations('maintenance.weekdays')
  const tLastDay = useTranslations('maintenance.lastDays')
  const format = useFormatter()
  const router = useRouter()
  const [pending, setPending] = React.useState(false)

  const schema = React.useMemo(
    () =>
      createMaintenanceFormSchema({
        titleRequired: tv('titleRequired'),
        dateTime: tv('dateTime'),
        time: tv('time'),
        timezone: tv('timezone'),
        startRequired: tv('startRequired'),
        endRequired: tv('endRequired'),
        endAfterStart: tv('endAfterStart'),
        windowLength: tv('windowLength'),
        pickDay: tv('pickDay'),
        cron: tv('cron'),
      }),
    [tv],
  )

  const form = useForm<MaintenanceFormInput, unknown, MaintenanceFormValues>({
    resolver: zodResolver(schema),
    defaultValues: initialValues,
    mode: 'onTouched',
  })
  const { control, setValue, getValues } = form

  const [strategy, timezone, cron, dateStart] = useWatch({
    control,
    name: ['strategy', 'timezone', 'cron', 'dateRange.start'],
  })
  const scheduled = hasSchedule(strategy)
  const recurring = isRecurringStrategy(strategy)
  const previewZone =
    timezone && timezone !== SAME_AS_SERVER ? timezone : timeZoneOrDefault(orgTimezone)
  const preview = React.useMemo(
    () =>
      strategy === 'cron' && cron
        ? cronPreview(cron, timezone ?? SAME_AS_SERVER, timeZoneOrDefault(orgTimezone))
        : null,
    [strategy, cron, timezone, orgTimezone],
  )

  const monitorOptions = React.useMemo(
    () =>
      monitors.map((m) => ({
        id: m.id,
        label: m.name,
        hint: m.parent ? `${m.parent} · ${m.type}` : m.type,
      })),
    [monitors],
  )
  const pageOptions = React.useMemo(
    () => statusPages.map((p) => ({ id: p.id, label: p.title, hint: `/status/${p.slug}` })),
    [statusPages],
  )

  /** Single windows: set the end from the start plus a preset (Uptime Kuma's quick buttons). */
  function applyQuickDuration(minutes: number) {
    const start = getValues('dateRange.start')
    if (!start) {
      toast.error(t('setStartFirst'))
      return
    }
    const from = new Date(start)
    if (Number.isNaN(from.getTime())) return
    setValue('dateRange.end', toDateTimeLocal(new Date(from.getTime() + minutes * 60_000)), {
      shouldDirty: true,
      shouldValidate: true,
    })
  }

  async function onSubmit(values: MaintenanceFormValues) {
    if (values.monitors.length === 0 && values.statusPages.length === 0) {
      form.setError('monitors', {
        message: t('noTargets'),
      })
      return
    }
    setPending(true)
    try {
      if (mode === 'create') await maintenanceApi.create(orgId, values)
      else await maintenanceApi.update(orgId, maintenanceId as string, values)
      toast.success(mode === 'create' ? t('created') : t('saved'))
      router.push(`/${orgSlug}/maintenance`)
      router.refresh()
    } catch (error) {
      setPending(false)
      const issues =
        error instanceof ApiError &&
        error.details &&
        typeof error.details === 'object' &&
        'errors' in error.details
          ? ((
              error.details as {
                errors?: { data?: { issues?: { path: string; message: string }[] } }[]
              }
            ).errors?.[0]?.data?.issues ?? [])
          : []
      if (issues.length) {
        for (const issue of issues) form.setError(issue.path as Name, { message: issue.message })
        toast.error(t('fixFields'))
      } else {
        toast.error(error instanceof Error ? error.message : t('saveFailed'))
      }
    }
  }

  const dayOfMonthOptions = React.useMemo<{ value: DayOfMonthValue; label: string }[]>(
    () =>
      Array.from({ length: 31 }, (_, i) => ({
        value: String(i + 1) as DayOfMonthValue,
        label: String(i + 1),
      })),
    [],
  )
  const lastDayOptions = React.useMemo<{ value: DayOfMonthValue; label: string }[]>(
    () => LAST_DAY_VALUES.map((value) => ({ value, label: tLastDay(value) })),
    [tLastDay],
  )
  const weekdayOptions = React.useMemo<{ value: WeekdayValue; label: string }[]>(
    () => WEEKDAY_ORDER.map((value) => ({ value, label: tWeekday(value) })),
    [tWeekday],
  )

  return (
    <Form {...form}>
      <form
        onSubmit={form.handleSubmit(onSubmit)}
        className="mx-auto flex w-full max-w-3xl flex-col gap-6"
        noValidate
        data-testid="maintenance-form"
      >
        {/* General ------------------------------------------------------------------------- */}
        <Card>
          <CardHeader>
            <CardTitle>{t('general.title')}</CardTitle>
            <CardDescription>{t('general.description')}</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-5">
            <TextInputField
              control={control}
              name="title"
              label={t('title')}
              placeholder={t('titlePlaceholder')}
            />
            <FormField
              control={control}
              name="description"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('description')}</FormLabel>
                  <FormControl>
                    <Textarea
                      rows={3}
                      placeholder={t('descriptionPlaceholder')}
                      {...field}
                      value={(field.value as string | null | undefined) ?? ''}
                    />
                  </FormControl>
                  <FormDescription>{t('descriptionHint')}</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={control}
              name="active"
              render={({ field }) => (
                <FormItem className="flex flex-row items-start justify-between gap-4 rounded-lg border p-3">
                  <div className="space-y-0.5">
                    <FormLabel>{t('active')}</FormLabel>
                    <FormDescription>{t('activeHint')}</FormDescription>
                  </div>
                  <FormControl>
                    <Switch checked={field.value !== false} onCheckedChange={field.onChange} />
                  </FormControl>
                </FormItem>
              )}
            />
          </CardContent>
        </Card>

        {/* Schedule ------------------------------------------------------------------------ */}
        <Card>
          <CardHeader>
            <CardTitle>{t('schedule.title')}</CardTitle>
            <CardDescription>
              {tHelp((strategy as MaintenanceStrategy) ?? 'single')}
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-5">
            <FormField
              control={control}
              name="strategy"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('strategy')}</FormLabel>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <FormControl>
                      <SelectTrigger className="w-full" data-testid="strategy-select">
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {MAINTENANCE_STRATEGIES.map((value) => (
                        <SelectItem key={value} value={value}>
                          {tStrategy(value)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

            {strategy === 'cron' && (
              <div className="grid gap-5 sm:grid-cols-[minmax(0,1fr)_10rem]">
                <TextInputField
                  control={control}
                  name="cron"
                  label={t('cron')}
                  placeholder="30 3 * * *"
                  mono
                  description={
                    preview ? (
                      <span suppressHydrationWarning>
                        {t('cronNext', {
                          runs: preview
                            .map((d) => format.dateTime(d, 'zoned', { timeZone: previewZone }))
                            .join(' · '),
                        })}
                      </span>
                    ) : (
                      t('cronHint')
                    )
                  }
                />
                <NumberInputField
                  control={control}
                  name="duration"
                  label={t('duration')}
                  min={1}
                  max={MAX_DURATION_MINUTES}
                  unit={t('minutesUnit')}
                />
              </div>
            )}

            {strategy === 'recurring-interval' && (
              <NumberInputField
                control={control}
                name="intervalDay"
                label={t('interval')}
                min={1}
                max={MAX_INTERVAL_DAYS}
                unit={t('daysUnit')}
                description={t('intervalHint')}
              />
            )}

            {strategy === 'recurring-weekday' && (
              <ToggleGroupField<WeekdayValue>
                control={control}
                name="weekdays"
                label={t('weekdays')}
                options={weekdayOptions}
                columns="grid-cols-4 sm:grid-cols-7"
              />
            )}

            {strategy === 'recurring-day-of-month' && (
              <>
                <ToggleGroupField<DayOfMonthValue>
                  control={control}
                  name="daysOfMonth"
                  label={t('daysOfMonth')}
                  options={dayOfMonthOptions}
                  columns="grid-cols-7 sm:grid-cols-11"
                />
                <ToggleGroupField<DayOfMonthValue>
                  control={control}
                  name="daysOfMonth"
                  label={t('lastDaysOfMonth')}
                  options={lastDayOptions}
                  columns="grid-cols-1 sm:grid-cols-2"
                  description={t('lastDaysHint')}
                />
              </>
            )}

            {recurring && (
              <div className="grid gap-5 sm:grid-cols-2">
                <TextInputField
                  control={control}
                  name="timeRange.start"
                  label={t('windowStarts')}
                  type="time"
                />
                <TextInputField
                  control={control}
                  name="timeRange.end"
                  label={t('windowEnds')}
                  type="time"
                  description={t('windowEndsHint')}
                />
              </div>
            )}

            {scheduled && (
              <FormField
                control={control}
                name="timezone"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('timezone')}</FormLabel>
                    <FormControl>
                      <TimezoneSelect
                        value={field.value ?? SAME_AS_SERVER}
                        onChange={field.onChange}
                        extraOptions={[
                          {
                            value: SAME_AS_SERVER,
                            label: t('timezoneDefault', { zone: orgTimezone }),
                          },
                        ]}
                      />
                    </FormControl>
                    <FormDescription>{t('timezoneHint')}</FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}

            {scheduled && (
              <div className="grid gap-5 sm:grid-cols-2">
                <TextInputField
                  control={control}
                  name="dateRange.start"
                  label={strategy === 'single' ? t('starts') : t('effectiveFrom')}
                  type="datetime-local"
                />
                <TextInputField
                  control={control}
                  name="dateRange.end"
                  label={strategy === 'single' ? t('ends') : t('effectiveUntil')}
                  type="datetime-local"
                  description={strategy === 'single' ? undefined : t('effectiveUntilHint')}
                />
              </div>
            )}

            {strategy === 'single' && (
              <div className="flex flex-wrap gap-2" aria-label={t('quickDurations')}>
                {QUICK_DURATIONS.map((minutes) => (
                  <Button
                    key={minutes}
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={!dateStart}
                    onClick={() => applyQuickDuration(minutes)}
                  >
                    {minutes < 60
                      ? t('quickMinutes', { minutes })
                      : t('quickHours', { hours: minutes / 60 })}
                  </Button>
                ))}
                <span className="self-center text-xs text-muted-foreground">{t('quickHint')}</span>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Targets ------------------------------------------------------------------------- */}
        <Card>
          <CardHeader>
            <CardTitle>{t('monitors.title')}</CardTitle>
            <CardDescription>{t('monitors.description')}</CardDescription>
          </CardHeader>
          <CardContent>
            <FormField
              control={control}
              name="monitors"
              render={({ field }) => (
                <FormItem>
                  <FormControl>
                    <PickerList
                      label={t('monitors.label')}
                      options={monitorOptions}
                      value={((field.value as (string | number)[] | undefined) ?? []).map(String)}
                      onChange={field.onChange}
                      placeholder={t('monitors.search')}
                      emptyText={t('monitors.empty')}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t('statusPages.title')}</CardTitle>
            <CardDescription>{t('statusPages.description')}</CardDescription>
          </CardHeader>
          <CardContent>
            <FormField
              control={control}
              name="statusPages"
              render={({ field }) => (
                <FormItem>
                  <FormControl>
                    <PickerList
                      label={t('statusPages.label')}
                      options={pageOptions}
                      value={((field.value as (string | number)[] | undefined) ?? []).map(String)}
                      onChange={field.onChange}
                      placeholder={t('statusPages.search')}
                      emptyText={t('statusPages.empty')}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </CardContent>
        </Card>

        <div className="flex items-center justify-end gap-2">
          <Button variant="outline" asChild>
            <Link href={`/${orgSlug}/maintenance`}>{t('cancel')}</Link>
          </Button>
          <Button type="submit" disabled={pending} data-testid="maintenance-submit">
            {pending && <Loader2 className="animate-spin" />}
            {mode === 'create' ? t('create') : t('save')}
          </Button>
        </div>
      </form>
    </Form>
  )
}
