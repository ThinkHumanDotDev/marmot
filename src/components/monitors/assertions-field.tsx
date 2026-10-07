'use client'

import { Plus, Trash2 } from 'lucide-react'
import { useTranslations } from 'next-intl'
import {
  useFieldArray,
  useFormState,
  useWatch,
  type Control,
  type UseFormSetValue,
} from 'react-hook-form'

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
  ASSERTION_DNS_RECORD_TYPES,
  assertionKindsForType,
  COMPARATORS_BY_KIND,
  MAX_ASSERTIONS_PER_KIND,
  VALUELESS_COMPARATORS,
  type AssertionComparator,
  type AssertionKind,
  type MonitorAssertion,
} from '@/lib/validation/assertions'
import type { MonitorFormInput, MonitorFormValues } from '@/lib/validation/monitor'

type FormControlType = Control<MonitorFormInput, unknown, MonitorFormValues>

/** Placeholder of the value input per kind: technical example values, not prose. */
const VALUE_PLACEHOLDERS: Record<AssertionKind, string> = {
  status: '200',
  header: 'application/json',
  textBody: '"status":"ok"',
  jsonBody: 'ok',
  dnsRecord: 'mail.example.com',
}
const TARGET_PLACEHOLDERS: Partial<Record<AssertionKind, string>> = {
  header: 'content-type',
  jsonBody: '$.status',
}

/**
 * Repeatable assertion rows (kind / target / comparator / value) of the monitor form (#96).
 * Kinds are limited to what the monitor type supports; the worker evaluates them after each check.
 */
export function AssertionsField({
  control,
  setValue,
  monitorType,
  dnsRecordType,
}: {
  control: FormControlType
  setValue: UseFormSetValue<MonitorFormInput>
  monitorType: string
  /** The DNS monitor's own record type, the default target of `dnsRecord` rows. */
  dnsRecordType?: string | null
}) {
  const t = useTranslations('monitors.form.assertions')
  const { fields, append, remove } = useFieldArray({ control, name: 'assertions' })
  const rows = (useWatch({ control, name: 'assertions' }) ?? []) as MonitorAssertion[]
  const { errors } = useFormState({ control, name: 'assertions' })
  const kinds = assertionKindsForType(monitorType)

  const counts = new Map<AssertionKind, number>()
  for (const row of rows) counts.set(row.kind, (counts.get(row.kind) ?? 0) + 1)
  const available = kinds.filter((kind) => (counts.get(kind) ?? 0) < MAX_ASSERTIONS_PER_KIND)
  const listError =
    (errors.assertions as { message?: string; root?: { message?: string } })?.root?.message ??
    (errors.assertions as { message?: string } | undefined)?.message

  const addRow = () => {
    const kind = available[0]
    if (!kind) return
    append({ kind, target: null, comparator: COMPARATORS_BY_KIND[kind][0], value: null })
  }

  const changeKind = (index: number, kind: AssertionKind) => {
    setValue(`assertions.${index}.kind`, kind, { shouldDirty: true })
    const comparator = rows[index]?.comparator
    if (!comparator || !COMPARATORS_BY_KIND[kind].includes(comparator)) {
      setValue(`assertions.${index}.comparator`, COMPARATORS_BY_KIND[kind][0], {
        shouldDirty: true,
      })
    }
    setValue(`assertions.${index}.target`, null, { shouldDirty: true })
  }

  return (
    <div className="grid gap-4" data-testid="monitor-assertions">
      {fields.length === 0 && <p className="text-sm text-muted-foreground">{t('empty')}</p>}
      {fields.map((item, index) => {
        const row = rows[index] ?? (item as unknown as MonitorAssertion)
        const kind = row.kind
        const comparators = COMPARATORS_BY_KIND[kind] ?? []
        const needsValue = !VALUELESS_COMPARATORS.includes(row.comparator)
        const hasTarget = kind === 'header' || kind === 'jsonBody' || kind === 'dnsRecord'
        return (
          <div
            key={item.id}
            className="grid gap-3 rounded-lg border p-3 sm:grid-cols-[9rem_minmax(0,1fr)_9rem_minmax(0,1fr)_auto] sm:items-start"
            data-testid="assertion-row"
          >
            <FormField
              control={control}
              name={`assertions.${index}.kind`}
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-xs">{t('kind')}</FormLabel>
                  <Select
                    value={field.value}
                    onValueChange={(value) => changeKind(index, value as AssertionKind)}
                  >
                    <FormControl>
                      <SelectTrigger className="w-full" aria-label={t('kind')}>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {kinds.map((k) => (
                        <SelectItem
                          key={k}
                          value={k}
                          disabled={k !== kind && !available.includes(k)}
                        >
                          {t(`kinds.${k}`)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

            {hasTarget ? (
              <FormField
                control={control}
                name={`assertions.${index}.target`}
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="text-xs">{t(`targets.${kind}`)}</FormLabel>
                    {kind === 'dnsRecord' ? (
                      <Select
                        value={field.value ? String(field.value) : '__default__'}
                        onValueChange={(value) =>
                          field.onChange(value === '__default__' ? null : value)
                        }
                      >
                        <FormControl>
                          <SelectTrigger className="w-full">
                            <SelectValue />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="__default__">
                            {t('monitorRecordType', { type: dnsRecordType ?? 'A' })}
                          </SelectItem>
                          {ASSERTION_DNS_RECORD_TYPES.map((type) => (
                            <SelectItem key={type} value={type}>
                              {type}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      <FormControl>
                        <Input
                          {...field}
                          value={(field.value as string | null | undefined) ?? ''}
                          placeholder={TARGET_PLACEHOLDERS[kind]}
                          autoComplete="off"
                          className={kind === 'jsonBody' ? 'font-mono' : undefined}
                        />
                      </FormControl>
                    )}
                    <FormMessage />
                  </FormItem>
                )}
              />
            ) : (
              <div className="hidden sm:block" aria-hidden />
            )}

            <FormField
              control={control}
              name={`assertions.${index}.comparator`}
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-xs">{t('comparator')}</FormLabel>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <FormControl>
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {comparators.map((op: AssertionComparator) => (
                        <SelectItem key={op} value={op}>
                          {t(`comparators.${op}`)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

            {needsValue ? (
              <FormField
                control={control}
                name={`assertions.${index}.value`}
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="text-xs">{t('value')}</FormLabel>
                    <FormControl>
                      <Input
                        {...field}
                        value={(field.value as string | null | undefined) ?? ''}
                        placeholder={
                          row.comparator === 'matches' || row.comparator === 'not_matches'
                            ? '^ok$'
                            : VALUE_PLACEHOLDERS[kind]
                        }
                        autoComplete="off"
                        inputMode={kind === 'status' ? 'numeric' : undefined}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            ) : (
              <div className="hidden sm:block" aria-hidden />
            )}

            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="sm:mt-6"
              aria-label={t('remove', { index: index + 1 })}
              onClick={() => remove(index)}
            >
              <Trash2 />
            </Button>
          </div>
        )
      })}
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          variant="outline"
          onClick={addRow}
          disabled={available.length === 0}
          data-testid="assertion-add"
        >
          <Plus /> {t('add')}
        </Button>
        <p className="text-xs text-muted-foreground">
          {t('limit', { max: MAX_ASSERTIONS_PER_KIND })}
        </p>
      </div>
      {listError && <p className="text-sm text-destructive">{listError}</p>}
    </div>
  )
}
