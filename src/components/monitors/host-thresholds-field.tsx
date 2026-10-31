'use client'

import { Plus, Trash2 } from 'lucide-react'
import type * as React from 'react'
import { useTranslations } from 'next-intl'
import { get, useFieldArray, useFormState, useWatch, type Control } from 'react-hook-form'

import { Button } from '@/components/ui/button'
import { FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  HOST_MAX_THRESHOLDS,
  HOST_METRICS,
  HOST_TARGETED_METRICS,
  HOST_THRESHOLD_OPERATORS,
  HOST_THRESHOLD_SEVERITIES,
  type HostMetric,
  type HostThreshold,
} from '@/lib/host-metrics'
import type { MonitorFormInput, MonitorFormValues } from '@/lib/validation/monitor'

type FormControlType = Control<MonitorFormInput, unknown, MonitorFormValues>

/** Unit shown next to the value input, per metric (technical symbols, not prose). */
const UNITS: Record<HostMetric, string> = {
  cpu: '%',
  load1: '',
  load5: '',
  load15: '',
  memory: '%',
  swap: '%',
  disk: '%',
  temperature: '°C',
  'network-rx': 'B/s',
  'network-tx': 'B/s',
  'container-cpu': '%',
  'container-memory': '%',
}
/** Example targets: a mount point, a sensor, a container name. */
const TARGET_PLACEHOLDERS: Partial<Record<HostMetric, string>> = {
  disk: '/',
  temperature: 'coretemp Package id 0',
  'container-cpu': 'web',
  'container-memory': 'web',
}

function NumberInput({
  value,
  onChange,
  ...props
}: Omit<React.ComponentProps<typeof Input>, 'value' | 'onChange'> & {
  value: unknown
  onChange: (value: number | undefined) => void
}) {
  // Spreads the rest so `FormControl` can pass its id and aria attributes to the input.
  return (
    <Input
      {...props}
      type="number"
      inputMode="decimal"
      value={typeof value === 'number' && Number.isFinite(value) ? value : ''}
      onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
    />
  )
}

/**
 * Threshold rows of a host monitor (#136): metric, target (mount point, sensor or container; empty
 * means every one), comparison, value, how long it must hold and whether a breach is DOWN or
 * degraded. Judged by the host check after every interval.
 */
export function HostThresholdsField({ control }: { control: FormControlType }) {
  const t = useTranslations('monitors.form.host')
  const name = 'hostThresholds' as const
  const { fields, append, remove } = useFieldArray({ control, name })
  const rows = (useWatch({ control, name }) ?? []) as HostThreshold[]
  const { errors } = useFormState({ control, name })
  const listErrors = get(errors, name) as
    { message?: string; root?: { message?: string } } | undefined
  const listError = listErrors?.root?.message ?? listErrors?.message

  return (
    <div className="grid gap-4" data-testid="host-thresholds">
      {fields.length === 0 && <p className="text-sm text-muted-foreground">{t('empty')}</p>}
      {fields.map((item, index) => {
        const row = rows[index] ?? (item as unknown as HostThreshold)
        const targeted = HOST_TARGETED_METRICS.includes(row.metric)
        return (
          <div
            key={item.id}
            className="grid gap-3 rounded-lg border p-3 sm:grid-cols-12 sm:items-start"
            data-testid="host-threshold-row"
          >
            <FormField
              control={control}
              name={`${name}.${index}.metric`}
              render={({ field }) => (
                <FormItem className="sm:col-span-4">
                  <FormLabel className="text-xs">{t('metric')}</FormLabel>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <FormControl>
                      <SelectTrigger className="w-full" aria-label={t('metric')}>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {HOST_METRICS.map((metric) => (
                        <SelectItem key={metric} value={metric}>
                          {t(`metrics.${metric}`)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={control}
              name={`${name}.${index}.target`}
              render={({ field }) => (
                <FormItem className="sm:col-span-5">
                  <FormLabel className="text-xs">{t('target')}</FormLabel>
                  <FormControl>
                    <Input
                      aria-label={t('target')}
                      disabled={!targeted}
                      placeholder={
                        targeted
                          ? t('targetAll', { example: TARGET_PLACEHOLDERS[row.metric] ?? '' })
                          : ''
                      }
                      value={targeted ? ((field.value as string | null | undefined) ?? '') : ''}
                      onChange={(e) => field.onChange(e.target.value || null)}
                      autoComplete="off"
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={control}
              name={`${name}.${index}.operator`}
              render={({ field }) => (
                <FormItem className="sm:col-span-3">
                  <FormLabel className="text-xs">{t('operator')}</FormLabel>
                  <Select value={field.value ?? '>'} onValueChange={field.onChange}>
                    <FormControl>
                      <SelectTrigger className="w-full" aria-label={t('operator')}>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {HOST_THRESHOLD_OPERATORS.map((operator) => (
                        <SelectItem key={operator} value={operator}>
                          {operator}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </FormItem>
              )}
            />
            <FormField
              control={control}
              name={`${name}.${index}.value`}
              render={({ field }) => (
                <FormItem className="sm:col-span-4">
                  <FormLabel className="text-xs">
                    {UNITS[row.metric]
                      ? t('valueWithUnit', { unit: UNITS[row.metric] })
                      : t('value')}
                  </FormLabel>
                  <FormControl>
                    <NumberInput
                      value={field.value}
                      onChange={field.onChange}
                      aria-label={t('value')}
                      step="any"
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={control}
              name={`${name}.${index}.duration`}
              render={({ field }) => (
                <FormItem className="sm:col-span-4">
                  <FormLabel className="text-xs">{t('duration')}</FormLabel>
                  <FormControl>
                    <NumberInput
                      value={field.value}
                      onChange={(value) => field.onChange(value ?? 0)}
                      aria-label={t('duration')}
                      step={1}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={control}
              name={`${name}.${index}.severity`}
              render={({ field }) => (
                <FormItem className="sm:col-span-3">
                  <FormLabel className="text-xs">{t('severity')}</FormLabel>
                  <Select value={field.value ?? 'down'} onValueChange={field.onChange}>
                    <FormControl>
                      <SelectTrigger className="w-full" aria-label={t('severity')}>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {HOST_THRESHOLD_SEVERITIES.map((severity) => (
                        <SelectItem key={severity} value={severity}>
                          {t(`severities.${severity}`)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </FormItem>
              )}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="sm:col-span-1 sm:mt-6 sm:justify-self-end"
              aria-label={t('remove')}
              onClick={() => remove(index)}
            >
              <Trash2 aria-hidden />
            </Button>
          </div>
        )
      })}
      {listError && <p className="text-sm text-destructive">{listError}</p>}
      <div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={fields.length >= HOST_MAX_THRESHOLDS}
          onClick={() =>
            append({
              metric: 'disk',
              target: null,
              operator: '>',
              value: 90,
              duration: 0,
              severity: 'down',
            })
          }
          data-testid="host-threshold-add"
        >
          <Plus aria-hidden /> {t('add')}
        </Button>
      </div>
    </div>
  )
}
