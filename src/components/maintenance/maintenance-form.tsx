'use client'

import { zodResolver } from '@hookform/resolvers/zod'
import { Cron } from 'croner'
import { Loader2 } from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
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
import {
  hasSchedule,
  isRecurringStrategy,
  LAST_DAY_LABELS,
  LAST_DAY_VALUES,
  MAINTENANCE_STRATEGIES,
  MAINTENANCE_STRATEGY_LABELS,
  MAX_DURATION_MINUTES,
  MAX_INTERVAL_DAYS,
  maintenanceFormSchema,
  SAME_AS_SERVER,
  toDateTimeLocal,
  WEEKDAY_OPTIONS,
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

const STRATEGY_HELP: Record<MaintenanceStrategy, string> = {
  manual: 'Starts now and stays active until you pause or delete it.',
  single: 'One window between a start and an end date.',
  'recurring-interval':
    'Repeats every N days at the same time of day, counted from the start date.',
  'recurring-weekday': 'Repeats on the chosen days of the week.',
  'recurring-day-of-month': 'Repeats on the chosen days of the month.',
  cron: 'Starts whenever the cron expression matches and lasts the given number of minutes.',
}

const QUICK_DURATIONS: { minutes: number; label: string }[] = [
  { minutes: 15, label: '15 min' },
  { minutes: 30, label: '30 min' },
  { minutes: 60, label: '1 h' },
  { minutes: 120, label: '2 h' },
  { minutes: 240, label: '4 h' },
  { minutes: 480, label: '8 h' },
  { minutes: 720, label: '12 h' },
  { minutes: 1440, label: '24 h' },
]

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

/** Next matches of a cron expression, for a quick sanity check while typing. */
function cronPreview(pattern: string, timezone: string): string[] | null {
  try {
    const zone = timezone === SAME_AS_SERVER ? undefined : timezone
    const job = new Cron(pattern, zone ? { timezone: zone } : {})
    return job.nextRuns(3).map((d) => d.toLocaleString())
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
  const router = useRouter()
  const [pending, setPending] = React.useState(false)

  const form = useForm<MaintenanceFormInput, unknown, MaintenanceFormValues>({
    resolver: zodResolver(maintenanceFormSchema),
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
  const preview = React.useMemo(
    () => (strategy === 'cron' && cron ? cronPreview(cron, timezone ?? SAME_AS_SERVER) : null),
    [strategy, cron, timezone],
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
      toast.error('Set the start first')
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
        message: 'Pick at least one monitor or status page, otherwise the window does nothing.',
      })
      return
    }
    setPending(true)
    try {
      if (mode === 'create') await maintenanceApi.create(orgId, values)
      else await maintenanceApi.update(orgId, maintenanceId as string, values)
      toast.success(mode === 'create' ? 'Maintenance scheduled' : 'Maintenance saved')
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
        toast.error('Please fix the highlighted fields')
      } else {
        toast.error(error instanceof Error ? error.message : 'Could not save the maintenance')
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
    () => LAST_DAY_VALUES.map((value) => ({ value, label: LAST_DAY_LABELS[value] })),
    [],
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
            <CardTitle>General</CardTitle>
            <CardDescription>What visitors and teammates read about this window.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-5">
            <TextInputField
              control={control}
              name="title"
              label="Title"
              placeholder="Database upgrade"
            />
            <FormField
              control={control}
              name="description"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Description</FormLabel>
                  <FormControl>
                    <Textarea
                      rows={3}
                      placeholder="What is happening and what to expect."
                      {...field}
                      value={(field.value as string | null | undefined) ?? ''}
                    />
                  </FormControl>
                  <FormDescription>
                    Shown on the selected status pages. Markdown supported.
                  </FormDescription>
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
                    <FormLabel>Active</FormLabel>
                    <FormDescription>
                      Paused maintenances never apply, whatever the schedule.
                    </FormDescription>
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
            <CardTitle>Date and time</CardTitle>
            <CardDescription>
              {STRATEGY_HELP[(strategy as MaintenanceStrategy) ?? 'single']}
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-5">
            <FormField
              control={control}
              name="strategy"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Strategy</FormLabel>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <FormControl>
                      <SelectTrigger className="w-full" data-testid="strategy-select">
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {MAINTENANCE_STRATEGIES.map((value) => (
                        <SelectItem key={value} value={value}>
                          {MAINTENANCE_STRATEGY_LABELS[value]}
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
                  label="Cron expression"
                  placeholder="30 3 * * *"
                  mono
                  description={
                    preview ? (
                      <span suppressHydrationWarning>Next: {preview.join(' · ')}</span>
                    ) : (
                      'minute hour day-of-month month day-of-week'
                    )
                  }
                />
                <NumberInputField
                  control={control}
                  name="duration"
                  label="Duration"
                  min={1}
                  max={MAX_DURATION_MINUTES}
                  unit="min"
                />
              </div>
            )}

            {strategy === 'recurring-interval' && (
              <NumberInputField
                control={control}
                name="intervalDay"
                label="Interval"
                min={1}
                max={MAX_INTERVAL_DAYS}
                unit="days"
                description="1 = every day. Counted from the start date below."
              />
            )}

            {strategy === 'recurring-weekday' && (
              <ToggleGroupField<WeekdayValue>
                control={control}
                name="weekdays"
                label="Days of the week"
                options={WEEKDAY_OPTIONS}
                columns="grid-cols-4 sm:grid-cols-7"
              />
            )}

            {strategy === 'recurring-day-of-month' && (
              <>
                <ToggleGroupField<DayOfMonthValue>
                  control={control}
                  name="daysOfMonth"
                  label="Days of the month"
                  options={dayOfMonthOptions}
                  columns="grid-cols-7 sm:grid-cols-11"
                />
                <ToggleGroupField<DayOfMonthValue>
                  control={control}
                  name="daysOfMonth"
                  label="Last days of the month"
                  options={lastDayOptions}
                  columns="grid-cols-1 sm:grid-cols-2"
                  description="Only the last day of the month has a cron equivalent; the others are accepted but not scheduled."
                />
              </>
            )}

            {recurring && (
              <div className="grid gap-5 sm:grid-cols-2">
                <TextInputField
                  control={control}
                  name="timeRange.start"
                  label="Window starts"
                  type="time"
                />
                <TextInputField
                  control={control}
                  name="timeRange.end"
                  label="Window ends"
                  type="time"
                  description="An end before the start runs past midnight."
                />
              </div>
            )}

            {scheduled && (
              <FormField
                control={control}
                name="timezone"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Time zone</FormLabel>
                    <FormControl>
                      <TimezoneSelect
                        value={field.value ?? SAME_AS_SERVER}
                        onChange={field.onChange}
                        extraOptions={[
                          { value: SAME_AS_SERVER, label: `Organization default (${orgTimezone})` },
                        ]}
                      />
                    </FormControl>
                    <FormDescription>Dates and times above are read in this zone.</FormDescription>
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
                  label={strategy === 'single' ? 'Starts' : 'Effective from'}
                  type="datetime-local"
                />
                <TextInputField
                  control={control}
                  name="dateRange.end"
                  label={strategy === 'single' ? 'Ends' : 'Effective until'}
                  type="datetime-local"
                  description={
                    strategy === 'single' ? undefined : 'Optional. Leave empty to repeat forever.'
                  }
                />
              </div>
            )}

            {strategy === 'single' && (
              <div className="flex flex-wrap gap-2" aria-label="Quick durations">
                {QUICK_DURATIONS.map((preset) => (
                  <Button
                    key={preset.minutes}
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={!dateStart}
                    onClick={() => applyQuickDuration(preset.minutes)}
                  >
                    {preset.label}
                  </Button>
                ))}
                <span className="self-center text-xs text-muted-foreground">
                  Sets the end relative to the start.
                </span>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Targets ------------------------------------------------------------------------- */}
        <Card>
          <CardHeader>
            <CardTitle>Affected monitors</CardTitle>
            <CardDescription>
              These monitors (and the children of selected groups) are not checked while the window
              runs; they report MAINTENANCE instead.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <FormField
              control={control}
              name="monitors"
              render={({ field }) => (
                <FormItem>
                  <FormControl>
                    <PickerList
                      label="monitors"
                      options={monitorOptions}
                      value={((field.value as (string | number)[] | undefined) ?? []).map(String)}
                      onChange={field.onChange}
                      placeholder="Search monitors…"
                      emptyText="This organization has no monitors yet."
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
            <CardTitle>Status pages</CardTitle>
            <CardDescription>
              Pages that announce the window to visitors, running or upcoming.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <FormField
              control={control}
              name="statusPages"
              render={({ field }) => (
                <FormItem>
                  <FormControl>
                    <PickerList
                      label="status pages"
                      options={pageOptions}
                      value={((field.value as (string | number)[] | undefined) ?? []).map(String)}
                      onChange={field.onChange}
                      placeholder="Search status pages…"
                      emptyText="This organization has no status pages yet."
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
            <Link href={`/${orgSlug}/maintenance`}>Cancel</Link>
          </Button>
          <Button type="submit" disabled={pending} data-testid="maintenance-submit">
            {pending && <Loader2 className="animate-spin" />}
            {mode === 'create' ? 'Schedule maintenance' : 'Save changes'}
          </Button>
        </div>
      </form>
    </Form>
  )
}
