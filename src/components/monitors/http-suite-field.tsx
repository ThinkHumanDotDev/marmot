'use client'

import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react'
import { useTranslations } from 'next-intl'
import {
  get,
  useFieldArray,
  useFormState,
  useWatch,
  type Control,
  type FieldValues,
  type UseFormSetValue,
} from 'react-hook-form'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
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
import {
  emptySuiteStep,
  MAX_SUITE_HEADERS,
  MAX_SUITE_STEPS,
  MAX_SUITE_STORE,
  MAX_SUITE_VARS,
  SUITE_AUTH_METHODS,
  SUITE_BODY_ENCODINGS,
  SUITE_HTTP_METHODS,
  type HttpSuiteStep,
} from '@/lib/validation/http-suite'
import type { MonitorFormInput, MonitorFormValues } from '@/lib/validation/monitor'

import { AssertionsField } from './assertions-field'

type MonitorControl = Control<MonitorFormInput, unknown, MonitorFormValues>
/** The suite's paths are built at runtime (`httpSuite.steps.2.url`), so fields use a loose control. */
type LooseControl = Control<FieldValues>

function TextInput({
  control,
  name,
  label,
  placeholder,
  description,
  type = 'text',
  mono = false,
}: {
  control: LooseControl
  name: string
  label: string
  placeholder?: string
  description?: string
  type?: string
  mono?: boolean
}) {
  return (
    <FormField
      control={control}
      name={name}
      render={({ field }) => (
        <FormItem>
          <FormLabel className="text-xs">{label}</FormLabel>
          <FormControl>
            <Input
              type={type}
              placeholder={placeholder}
              autoComplete="off"
              className={mono ? 'font-mono text-xs' : undefined}
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

function SelectInput({
  control,
  name,
  label,
  options,
}: {
  control: LooseControl
  name: string
  label: string
  options: { value: string; label: string }[]
}) {
  return (
    <FormField
      control={control}
      name={name}
      render={({ field }) => (
        <FormItem>
          <FormLabel className="text-xs">{label}</FormLabel>
          <Select
            value={(field.value as string | undefined) ?? undefined}
            onValueChange={field.onChange}
          >
            <FormControl>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
            </FormControl>
            <SelectContent>
              {options.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <FormMessage />
        </FormItem>
      )}
    />
  )
}

function SwitchInput({
  control,
  name,
  label,
  description,
}: {
  control: LooseControl
  name: string
  label: string
  description?: string
}) {
  return (
    <FormField
      control={control}
      name={name}
      render={({ field }) => (
        <FormItem className="flex flex-row items-start justify-between gap-4 rounded-lg border p-3">
          <div className="space-y-0.5">
            <FormLabel className="text-xs">{label}</FormLabel>
            {description && <FormDescription>{description}</FormDescription>}
          </div>
          <FormControl>
            <Switch checked={Boolean(field.value)} onCheckedChange={field.onChange} />
          </FormControl>
        </FormItem>
      )}
    />
  )
}

/** Error of a list itself (e.g. "add at least one step"), not of one of its rows. */
function ListError({ control, name }: { control: LooseControl; name: string }) {
  const { errors } = useFormState({ control, name })
  const error = get(errors, name) as { message?: string; root?: { message?: string } } | undefined
  const message = error?.root?.message ?? error?.message
  return message ? <p className="text-sm text-destructive">{message}</p> : null
}

/** Name / value rows: suite variables, suite secrets and step headers. */
function PairRows({
  control,
  name,
  max,
  secret = false,
  namePlaceholder,
  valuePlaceholder,
  addLabel,
  testId,
}: {
  control: LooseControl
  name: string
  max: number
  secret?: boolean
  namePlaceholder: string
  valuePlaceholder: string
  addLabel: string
  testId: string
}) {
  const t = useTranslations('monitors.form.suite')
  const { fields, append, remove } = useFieldArray({ control, name })
  return (
    <div className="grid gap-2" data-testid={testId}>
      {fields.map((item, index) => (
        <div key={item.id} className="grid gap-2 sm:grid-cols-[minmax(0,12rem)_minmax(0,1fr)_auto]">
          <TextInput
            control={control}
            name={`${name}.${index}.name`}
            label={t('name')}
            placeholder={namePlaceholder}
            mono
          />
          <TextInput
            control={control}
            name={`${name}.${index}.value`}
            label={t('value')}
            placeholder={valuePlaceholder}
            type={secret ? 'password' : 'text'}
            mono
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="sm:mt-6"
            aria-label={t('removeRow', { index: index + 1 })}
            onClick={() => remove(index)}
          >
            <Trash2 />
          </Button>
        </div>
      ))}
      <div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={fields.length >= max}
          onClick={() => append({ name: '', value: '' })}
        >
          <Plus /> {addLabel}
        </Button>
      </div>
    </div>
  )
}

/** Values a step stores from its response for later steps. */
function StoreRows({ control, name }: { control: LooseControl; name: string }) {
  const t = useTranslations('monitors.form.suite')
  const { fields, append, remove } = useFieldArray({ control, name })
  return (
    <div className="grid gap-2" data-testid="suite-store">
      {fields.map((item, index) => (
        <div
          key={item.id}
          className="grid gap-2 sm:grid-cols-[minmax(0,10rem)_minmax(0,1fr)_auto_auto] sm:items-start"
        >
          <TextInput
            control={control}
            name={`${name}.${index}.name`}
            label={t('name')}
            placeholder="token"
            mono
          />
          <TextInput
            control={control}
            name={`${name}.${index}.from`}
            label={t('storeFrom')}
            placeholder="$.data.token"
            mono
          />
          <FormField
            control={control}
            name={`${name}.${index}.secret`}
            render={({ field }) => (
              <FormItem className="flex flex-col items-start gap-2">
                <FormLabel className="text-xs">{t('storeSecret')}</FormLabel>
                <FormControl>
                  <Switch checked={Boolean(field.value)} onCheckedChange={field.onChange} />
                </FormControl>
              </FormItem>
            )}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="sm:mt-6"
            aria-label={t('removeRow', { index: index + 1 })}
            onClick={() => remove(index)}
          >
            <Trash2 />
          </Button>
        </div>
      ))}
      <div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={fields.length >= MAX_SUITE_STORE}
          onClick={() => append({ name: '', from: '', secret: false })}
        >
          <Plus /> {t('addStore')}
        </Button>
      </div>
    </div>
  )
}

/** Accepted status codes as a comma-separated input (stored as a list). */
function StatusCodesInput({ control, name }: { control: LooseControl; name: string }) {
  const t = useTranslations('monitors.form.suite')
  return (
    <FormField
      control={control}
      name={name}
      render={({ field }) => (
        <FormItem>
          <FormLabel className="text-xs">{t('statusCodes')}</FormLabel>
          <FormControl>
            <Input
              name={field.name}
              ref={field.ref}
              onBlur={field.onBlur}
              placeholder="200-299"
              autoComplete="off"
              value={Array.isArray(field.value) ? (field.value as string[]).join(', ') : ''}
              onChange={(event) =>
                field.onChange(event.target.value.split(',').map((code) => code.trim()))
              }
            />
          </FormControl>
          <FormDescription>{t('statusCodesDescription')}</FormDescription>
          <FormMessage />
        </FormItem>
      )}
    />
  )
}

function StepCard({
  control,
  setValue,
  index,
  count,
  onMove,
  onRemove,
}: {
  control: LooseControl
  setValue: UseFormSetValue<MonitorFormInput>
  index: number
  count: number
  onMove: (from: number, to: number) => void
  onRemove: () => void
}) {
  const t = useTranslations('monitors.form.suite')
  const tHttp = useTranslations('monitors.form.http')
  const path = `httpSuite.steps.${index}`
  const step = useWatch({ control, name: path }) as HttpSuiteStep | undefined
  const method = step?.method ?? 'GET'
  const hasBody = method !== 'GET' && method !== 'HEAD'
  return (
    <section className="grid gap-4 rounded-lg border p-4" data-testid="suite-step">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="flex items-center gap-2 text-sm font-medium">
          {t('stepTitle', { index: index + 1 })}
          {step?.alwaysRun && <Badge variant="secondary">{t('cleanupBadge')}</Badge>}
        </h4>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            disabled={index === 0}
            aria-label={t('moveUp', { index: index + 1 })}
            onClick={() => onMove(index, index - 1)}
          >
            <ArrowUp />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            disabled={index === count - 1}
            aria-label={t('moveDown', { index: index + 1 })}
            onClick={() => onMove(index, index + 1)}
          >
            <ArrowDown />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={t('removeStep', { index: index + 1 })}
            onClick={onRemove}
          >
            <Trash2 />
          </Button>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <TextInput
          control={control}
          name={`${path}.key`}
          label={t('key')}
          placeholder="login"
          description={t('keyDescription', { example: '{{ steps.<key>.<name> }}' })}
          mono
        />
        <TextInput
          control={control}
          name={`${path}.name`}
          label={t('stepName')}
          placeholder={t('stepNamePlaceholder')}
        />
      </div>
      <div className="grid gap-3 sm:grid-cols-[8rem_minmax(0,1fr)]">
        <SelectInput
          control={control}
          name={`${path}.method`}
          label={tHttp('method')}
          options={SUITE_HTTP_METHODS.map((value) => ({ value, label: value }))}
        />
        <TextInput
          control={control}
          name={`${path}.url`}
          label={t('url')}
          placeholder="{{ vars.base }}/login"
          mono
        />
      </div>

      <div className="grid gap-2">
        <p className="text-xs font-medium">{t('headers')}</p>
        <PairRows
          control={control}
          name={`${path}.headers`}
          max={MAX_SUITE_HEADERS}
          namePlaceholder="Authorization"
          valuePlaceholder="Bearer {{ steps.login.token }}"
          addLabel={t('addHeader')}
          testId="suite-headers"
        />
      </div>

      {hasBody && (
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_8rem]">
          <FormField
            control={control}
            name={`${path}.body`}
            render={({ field }) => (
              <FormItem>
                <FormLabel className="text-xs">{tHttp('body')}</FormLabel>
                <FormControl>
                  <Textarea
                    rows={3}
                    className="font-mono text-xs"
                    placeholder={'{"user": "monitor", "password": "{{ secrets.password }}"}'}
                    {...field}
                    value={(field.value as string | null | undefined) ?? ''}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <SelectInput
            control={control}
            name={`${path}.bodyEncoding`}
            label={tHttp('bodyEncoding')}
            options={SUITE_BODY_ENCODINGS.map((value) => ({
              value,
              label: t(`bodyEncodings.${value}`),
            }))}
          />
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-3">
        <SelectInput
          control={control}
          name={`${path}.authMethod`}
          label={t('auth')}
          options={SUITE_AUTH_METHODS.map((value) => ({
            value,
            label: t(`authMethods.${value}`),
          }))}
        />
        {step?.authMethod === 'basic' && (
          <>
            <TextInput control={control} name={`${path}.basicAuthUser`} label={t('username')} />
            <TextInput
              control={control}
              name={`${path}.basicAuthPass`}
              label={t('password')}
              type="password"
            />
          </>
        )}
        {step?.authMethod === 'bearer' && (
          <div className="sm:col-span-2">
            <TextInput
              control={control}
              name={`${path}.bearerToken`}
              label={t('token')}
              placeholder="{{ steps.login.token }}"
              mono
            />
          </div>
        )}
      </div>

      <StatusCodesInput control={control} name={`${path}.acceptedStatusCodes`} />

      <div className="grid gap-2">
        <p className="text-xs font-medium">{t('assertions')}</p>
        <AssertionsField
          control={control as unknown as MonitorControl}
          setValue={setValue}
          monitorType="http"
          name={`httpSuite.steps.${index}.assertions`}
        />
      </div>

      <div className="grid gap-2">
        <p className="text-xs font-medium">{t('store')}</p>
        <p className="text-xs text-muted-foreground">{t('storeDescription')}</p>
        <StoreRows control={control} name={`${path}.store`} />
      </div>

      <SwitchInput
        control={control}
        name={`${path}.alwaysRun`}
        label={t('alwaysRun')}
        description={t('alwaysRunDescription')}
      />
    </section>
  )
}

/**
 * Editor of a multi-step API check (#138): suite variables and secrets, then the ordered steps,
 * each an HTTP request with its own headers, auth, accepted status codes, assertions (#96) and the
 * values it stores for later steps.
 */
export function HttpSuiteField({
  control: monitorControl,
  setValue,
}: {
  control: MonitorControl
  setValue: UseFormSetValue<MonitorFormInput>
}) {
  const t = useTranslations('monitors.form.suite')
  const control = monitorControl as unknown as LooseControl
  const { fields, append, remove, move } = useFieldArray({ control, name: 'httpSuite.steps' })
  return (
    <div className="grid gap-6" data-testid="http-suite">
      <p className="text-sm text-muted-foreground">
        {t('description', {
          vars: '{{ vars.name }}',
          secrets: '{{ secrets.name }}',
          steps: '{{ steps.key.name }}',
        })}
      </p>

      <div className="grid gap-2">
        <h3 className="text-sm font-medium">{t('vars')}</h3>
        <p className="text-xs text-muted-foreground">{t('varsDescription')}</p>
        <PairRows
          control={control}
          name="httpSuite.vars"
          max={MAX_SUITE_VARS}
          namePlaceholder="base"
          valuePlaceholder="https://api.example.com"
          addLabel={t('addVar')}
          testId="suite-vars"
        />
      </div>

      <div className="grid gap-2">
        <h3 className="text-sm font-medium">{t('secrets')}</h3>
        <p className="text-xs text-muted-foreground">{t('secretsDescription')}</p>
        <PairRows
          control={control}
          name="httpSuite.secrets"
          max={MAX_SUITE_VARS}
          secret
          namePlaceholder="password"
          valuePlaceholder="••••••••"
          addLabel={t('addSecret')}
          testId="suite-secrets"
        />
      </div>

      <div className="grid gap-3">
        <h3 className="text-sm font-medium">{t('steps')}</h3>
        {fields.map((item, index) => (
          <StepCard
            key={item.id}
            control={control}
            setValue={setValue}
            index={index}
            count={fields.length}
            onMove={move}
            onRemove={() => remove(index)}
          />
        ))}
        <ListError control={control} name="httpSuite.steps" />
        <div>
          <Button
            type="button"
            variant="outline"
            disabled={fields.length >= MAX_SUITE_STEPS}
            onClick={() => append(emptySuiteStep(fields.length))}
            data-testid="suite-add-step"
          >
            <Plus /> {t('addStep')}
          </Button>
        </div>
      </div>
    </div>
  )
}
