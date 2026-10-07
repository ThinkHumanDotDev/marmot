'use client'

import { zodResolver } from '@hookform/resolvers/zod'
import { FlaskConical, Loader2, Plus, X } from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import * as React from 'react'
import { useForm, useWatch, type Control, type FieldPath } from 'react-hook-form'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
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
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { track } from '@/lib/analytics'
import { api, ApiError } from '@/lib/api'
import { supportsDegradedThreshold } from '@/lib/monitor-degraded'
import { supportsAdhocTest, type OnDemandCheckResult } from '@/lib/on-demand-check'
import {
  AUTH_METHODS,
  BODY_ENCODINGS,
  DATABASE_CONNECTION_PLACEHOLDERS,
  DEFAULT_PORTS,
  defaultUrl,
  DNS_RECORD_TYPES,
  HTTP_METHODS,
  humanDuration,
  isDatabaseMonitorType,
  isHostMonitorType,
  isHttpMonitorType,
  isKeywordMonitorType,
  isPortMonitorType,
  isUrlMonitorType,
  isValidStatusCodeRange,
  JSON_PATH_OPERATORS,
  MANUAL_STATUSES,
  MONITOR_TYPE_GROUPS,
  type MonitorTypeGroup,
  createMonitorFormSchema,
  MQTT_CHECK_TYPES,
  OAUTH_AUTH_METHODS,
  SMTP_SECURITY_MODES,
  SNMP_VERSIONS,
  SSH_AUTH_METHODS,
  type MonitorFormInput,
  type MonitorFormValues,
  type MonitorTypeName,
} from '@/lib/validation/monitor'
import { supportsAssertions } from '@/lib/validation/assertions'
import type { MonitorFormResources } from '@/server/monitors/page-data'

import { AssertionsField } from './assertions-field'
import { useElapsedSeconds } from './check-now'
import { CheckResultView } from './check-result'
import { NotificationPicker } from './notification-picker'
import { TagChip } from './tag-chip'

export interface MonitorTypeInfo {
  name: string
  label: string
}

export interface GroupOption {
  id: string | number
  name: string
}

export interface MonitorFormProps {
  mode: 'create' | 'edit'
  orgId: string | number
  orgSlug: string
  monitorId?: string | number
  initialValues: MonitorFormValues
  /** Registered monitor types (from `listMonitorTypes()`); drives labels and hides unknown types. */
  types: MonitorTypeInfo[]
  /** Group monitors of the organization, for the parent select. */
  groups: GroupOption[]
  /** Tags, proxies, Docker hosts and notification channels of the organization for the selectors. */
  resources?: MonitorFormResources
  /**
   * `notification:read`: show the channel picker. Without it the form leaves `notifications` alone
   * (kept on edit, the organization's default channels on create).
   */
  canPickChannels?: boolean
}

const EMPTY_RESOURCES: MonitorFormResources = {
  tags: [],
  proxies: [],
  dockerHosts: [],
  notifications: [],
}

type Name = FieldPath<MonitorFormInput>
type FormControlType = Control<MonitorFormInput, unknown, MonitorFormValues>

const NONE = '__none__'

/** Field issues of a 400 answer (`{ errors: [{ data: { issues } }] }`), or none. */
function responseIssues(error: unknown): { path: string; message: string }[] {
  if (
    !(error instanceof ApiError) ||
    !error.details ||
    typeof error.details !== 'object' ||
    !('errors' in error.details)
  ) {
    return []
  }
  return (
    (
      error.details as {
        errors?: { data?: { issues?: { path: string; message: string }[] } }[]
      }
    ).errors?.[0]?.data?.issues ?? []
  )
}

/** WebSocket upgrades carry credentials only as headers or client certificates. */
const WS_AUTH_METHODS = AUTH_METHODS.filter((m) => m !== 'oauth2-cc' && m !== 'ntlm')

/** Types with a "Connection" card of their own fields. */
const hasConnectionSection = (type: MonitorTypeName | undefined): boolean =>
  Boolean(
    type &&
    (isDatabaseMonitorType(type) ||
      [
        'mqtt',
        'kafka-producer',
        'grpc-keyword',
        'radius',
        'snmp',
        'smtp',
        'sftp',
        'rabbitmq',
        'websocket-upgrade',
        'gamedig',
        'steam',
        'real-browser',
      ].includes(type)),
  )

// ---- Small field helpers ----------------------------------------------------------------------

function TextField({
  control,
  name,
  label,
  description,
  placeholder,
  type = 'text',
  autoComplete,
}: {
  control: FormControlType
  name: Name
  label: string
  description?: React.ReactNode
  placeholder?: string
  type?: string
  autoComplete?: string
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
              autoComplete={autoComplete}
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

function NumberField({
  control,
  name,
  label,
  description,
  min,
  max,
  step,
  unit,
}: {
  control: FormControlType
  name: Name
  label: string
  description?: React.ReactNode
  min?: number
  max?: number
  step?: number
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
                step={step}
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

function SelectField<T extends string>({
  control,
  name,
  label,
  description,
  options,
}: {
  control: FormControlType
  name: Name
  label: string
  description?: React.ReactNode
  options: { value: T; label: string }[]
}) {
  return (
    <FormField
      control={control}
      name={name}
      render={({ field }) => (
        <FormItem>
          <FormLabel>{label}</FormLabel>
          <Select
            value={(field.value as string | null | undefined) ?? undefined}
            onValueChange={field.onChange}
          >
            <FormControl>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
            </FormControl>
            <SelectContent>
              {options.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {description && <FormDescription>{description}</FormDescription>}
          <FormMessage />
        </FormItem>
      )}
    />
  )
}

function SwitchField({
  control,
  name,
  label,
  description,
}: {
  control: FormControlType
  name: Name
  label: string
  description?: React.ReactNode
}) {
  return (
    <FormField
      control={control}
      name={name}
      render={({ field }) => (
        <FormItem className="flex flex-row items-start justify-between gap-4 rounded-lg border p-3">
          <div className="space-y-0.5">
            <FormLabel>{label}</FormLabel>
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

function TextareaField({
  control,
  name,
  label,
  description,
  placeholder,
  rows = 4,
  mono = false,
}: {
  control: FormControlType
  name: Name
  label: string
  description?: React.ReactNode
  placeholder?: string
  rows?: number
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
            <Textarea
              rows={rows}
              placeholder={placeholder}
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

/** One entry per line (brokers, node URLs); stored as a string array. */
function ListField({
  control,
  name,
  label,
  description,
  placeholder,
}: {
  control: FormControlType
  name: Name
  label: string
  description?: React.ReactNode
  placeholder?: string
}) {
  const t = useTranslations('monitors.form')
  return (
    <FormField
      control={control}
      name={name}
      render={({ field }) => {
        const list = Array.isArray(field.value) ? (field.value as string[]) : []
        return (
          <FormItem>
            <FormLabel>{label}</FormLabel>
            <FormControl>
              <Textarea
                rows={3}
                placeholder={placeholder}
                className="font-mono text-xs"
                name={field.name}
                ref={field.ref}
                onBlur={field.onBlur}
                defaultValue={list.join('\n')}
                onChange={(e) =>
                  field.onChange(
                    e.target.value
                      .split(/[\n,]/)
                      .map((v) => v.trim())
                      .filter(Boolean),
                  )
                }
              />
            </FormControl>
            <FormDescription>{description ?? t('onePerLine')}</FormDescription>
            <FormMessage />
          </FormItem>
        )
      }}
    />
  )
}

/** Chip input for accepted status codes / ranges (Enter, comma or space adds; Backspace removes). */
function StatusCodesField({
  control,
  label,
  description,
}: {
  control: FormControlType
  label?: string
  description?: React.ReactNode
}) {
  const t = useTranslations('monitors.form')
  const [draft, setDraft] = React.useState('')
  return (
    <FormField
      control={control}
      name="acceptedStatusCodes"
      render={({ field }) => {
        const codes = (field.value as string[] | undefined) ?? []
        const add = () => {
          const value = draft.trim()
          if (!value) return
          if (!isValidStatusCodeRange(value)) return
          if (!codes.includes(value)) field.onChange([...codes, value])
          setDraft('')
        }
        return (
          <FormItem>
            <FormLabel>{label ?? t('statusCodes.label')}</FormLabel>
            <FormControl>
              <div className="flex min-h-9 flex-wrap items-center gap-1.5 rounded-md border border-input px-2 py-1 shadow-xs focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50 dark:bg-input/30">
                {codes.map((code) => (
                  <Badge key={code} variant="secondary" className="gap-1 pr-1 font-mono">
                    {code}
                    <button
                      type="button"
                      aria-label={t('statusCodes.remove', { code })}
                      className="rounded-full p-0.5 hover:bg-foreground/10"
                      onClick={() => field.onChange(codes.filter((c) => c !== code))}
                    >
                      <X className="size-3" />
                    </button>
                  </Badge>
                ))}
                <input
                  aria-label={t('statusCodes.add')}
                  className="h-7 min-w-24 flex-1 bg-transparent px-1 text-sm outline-none placeholder:text-muted-foreground"
                  placeholder={codes.length ? '' : '200-299'}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={add}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ',' || e.key === ' ') {
                      e.preventDefault()
                      add()
                    } else if (e.key === 'Backspace' && !draft && codes.length) {
                      field.onChange(codes.slice(0, -1))
                    }
                  }}
                />
              </div>
            </FormControl>
            <FormDescription>
              {description ??
                t.rich('statusCodes.description', { code: (chunks) => <code>{chunks}</code> })}
            </FormDescription>
            <FormMessage />
          </FormItem>
        )
      }}
    />
  )
}

/** Tag rows: chips of the selected tags plus a tag select + value input to add one. */
function TagsField({
  control,
  tags,
  orgSlug,
}: {
  control: FormControlType
  tags: MonitorFormResources['tags']
  orgSlug: string
}) {
  const t = useTranslations('monitors.form')
  const [draftTag, setDraftTag] = React.useState<string>('')
  const [draftValue, setDraftValue] = React.useState('')
  const byId = React.useMemo(() => new Map(tags.map((tag) => [String(tag.id), tag])), [tags])

  return (
    <FormField
      control={control}
      name="tags"
      render={({ field }) => {
        const rows = (field.value as { tag: string | number; value?: string | null }[]) ?? []
        const used = new Set(rows.map((row) => String(row.tag)))
        const available = tags.filter((tag) => !used.has(String(tag.id)))
        const add = () => {
          const tag = byId.get(draftTag)
          if (!tag) return
          field.onChange([...rows, { tag: tag.id, value: draftValue.trim() || null }])
          setDraftTag('')
          setDraftValue('')
        }
        return (
          <FormItem>
            <FormLabel>{t('tags.label')}</FormLabel>
            {rows.length > 0 && (
              <div className="flex flex-wrap gap-1.5" data-testid="monitor-tags">
                {rows.map((row) => {
                  const tag = byId.get(String(row.tag))
                  return (
                    <TagChip
                      key={String(row.tag)}
                      tag={{
                        name: tag?.name ?? t('tags.unknown'),
                        color: tag?.color,
                        value: row.value,
                      }}
                      className="py-1 text-xs"
                    >
                      <button
                        type="button"
                        aria-label={t('tags.remove', {
                          name: tag?.name ?? t('tags.removeFallback'),
                        })}
                        className="rounded-full p-0.5 hover:bg-foreground/10"
                        onClick={() =>
                          field.onChange(rows.filter((r) => String(r.tag) !== String(row.tag)))
                        }
                      >
                        <X className="size-3" />
                      </button>
                    </TagChip>
                  )
                })}
              </div>
            )}
            {tags.length === 0 ? (
              <FormDescription>
                {t.rich('tags.empty', {
                  link: (chunks) => (
                    <Link
                      href={`/${orgSlug}/settings/tags`}
                      className="underline underline-offset-2"
                    >
                      {chunks}
                    </Link>
                  ),
                })}
              </FormDescription>
            ) : (
              <>
                <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
                  <Select value={draftTag} onValueChange={setDraftTag}>
                    <SelectTrigger
                      className="w-full"
                      aria-label={t('tags.tagToAdd')}
                      disabled={available.length === 0}
                    >
                      <SelectValue
                        placeholder={available.length ? t('tags.chooseTag') : t('tags.allAdded')}
                      />
                    </SelectTrigger>
                    <SelectContent>
                      {available.map((tag) => (
                        <SelectItem key={String(tag.id)} value={String(tag.id)}>
                          <span
                            className="size-2.5 rounded-full"
                            style={{ backgroundColor: tag.color }}
                            aria-hidden
                          />
                          {tag.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Input
                    aria-label={t('tags.valueLabel')}
                    placeholder={t('tags.valuePlaceholder')}
                    value={draftValue}
                    maxLength={200}
                    onChange={(e) => setDraftValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        add()
                      }
                    }}
                  />
                  <Button type="button" variant="outline" onClick={add} disabled={!draftTag}>
                    <Plus /> {t('tags.add')}
                  </Button>
                </div>
                <FormDescription>
                  {t.rich('tags.description', {
                    link: (chunks) => (
                      <Link
                        href={`/${orgSlug}/settings/tags`}
                        className="underline underline-offset-2"
                      >
                        {chunks}
                      </Link>
                    ),
                  })}
                </FormDescription>
              </>
            )}
            <FormMessage />
          </FormItem>
        )
      }}
    />
  )
}

/** Select for an optional relationship (`None` + options), storing the original id type. */
function RelationSelectField({
  control,
  name,
  label,
  description,
  options,
  noneLabel,
}: {
  control: FormControlType
  name: Name
  label: string
  description?: React.ReactNode
  options: { id: string | number; label: string }[]
  /** `null` hides the "none" entry (required relationship). */
  noneLabel?: string | null
}) {
  const t = useTranslations('monitors.form')
  const none = noneLabel === undefined ? t('none') : noneLabel
  return (
    <FormField
      control={control}
      name={name}
      render={({ field }) => {
        const empty = field.value === null || field.value === undefined
        return (
          <FormItem>
            <FormLabel>{label}</FormLabel>
            <Select
              value={empty ? (none === null ? '' : NONE) : String(field.value)}
              onValueChange={(value) => {
                if (value === NONE) return field.onChange(null)
                const match = options.find((o) => String(o.id) === value)
                field.onChange(match ? match.id : value)
              }}
            >
              <FormControl>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder={t('choose')} />
                </SelectTrigger>
              </FormControl>
              <SelectContent>
                {none !== null && <SelectItem value={NONE}>{none}</SelectItem>}
                {options.map((o) => (
                  <SelectItem key={String(o.id)} value={String(o.id)}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {description && <FormDescription>{description}</FormDescription>}
            <FormMessage />
          </FormItem>
        )
      }}
    />
  )
}

// ---- Form ---------------------------------------------------------------------------------------

/** Defaults applied when the type changes so the target section is not left half-filled. */
function applyTypeDefaults(
  type: MonitorTypeName,
  get: (name: Name) => unknown,
  set: (name: Name, value: unknown) => void,
) {
  const url = get('url')
  const schemeOnly = url === 'https://' || url === 'wss://' || url === 'http://' || url === 'ws://'
  if (isUrlMonitorType(type) && (!url || schemeOnly)) set('url', defaultUrl(type))
  const defaultPort = DEFAULT_PORTS[type]
  if (defaultPort && !get('port')) set('port', defaultPort)
  if (type === 'dns' && !get('dnsResolveServer')) set('dnsResolveServer', '1.1.1.1')
  if (type === 'manual' && !get('manualStatus')) set('manualStatus', 'up')
  if (type === 'snmp' && !get('snmpCommunity')) set('snmpCommunity', 'public')
  const codes = get('acceptedStatusCodes')
  const isDefaultCodes = (list: unknown, value: string) =>
    Array.isArray(list) && list.length === 1 && list[0] === value
  if (type === 'websocket-upgrade' && isDefaultCodes(codes, '200-299')) {
    set('acceptedStatusCodes', ['1000'])
  } else if (type !== 'websocket-upgrade' && isDefaultCodes(codes, '1000')) {
    set('acceptedStatusCodes', ['200-299'])
  }
}

export function MonitorForm({
  mode,
  orgId,
  orgSlug,
  monitorId,
  initialValues,
  types,
  groups,
  resources = EMPTY_RESOURCES,
  canPickChannels = false,
}: MonitorFormProps) {
  const t = useTranslations('monitors.form')
  const tMonitors = useTranslations('monitors')
  const tValidation = useTranslations('monitors.validation')
  const tDuration = useTranslations('common.duration')
  const router = useRouter()
  const tChannels = useTranslations('monitors.channels')
  const [pending, setPending] = React.useState(false)
  // Client-side validation messages in the user's language (the API answers in English).
  const schema = React.useMemo(
    () => createMonitorFormSchema((key, values) => tValidation(key, values)),
    [tValidation],
  )

  const form = useForm<MonitorFormInput, unknown, MonitorFormValues>({
    resolver: zodResolver(schema),
    defaultValues: initialValues,
    mode: 'onTouched',
  })
  const { control, setValue, getValues } = form

  const [
    type,
    authMethod,
    interval,
    retryInterval,
    resendInterval,
    timeout,
    httpBodyEncoding,
    mqttCheckType,
    sshAuthMethod,
    dnsResolveType,
  ] = useWatch({
    control,
    name: [
      'type',
      'authMethod',
      'interval',
      'retryInterval',
      'resendInterval',
      'timeout',
      'httpBodyEncoding',
      'mqttCheckType',
      'sshAuthMethod',
      'dnsResolveType',
    ],
  })

  const isHttp = isHttpMonitorType(type)
  const isUrl = isUrlMonitorType(type)
  const isHost = isHostMonitorType(type)
  const isPort = isPortMonitorType(type)
  const isDatabase = isDatabaseMonitorType(type)
  const isWebSocket = type === 'websocket-upgrade'
  const showsJsonQuery =
    type === 'json-query' ||
    type === 'mongodb' ||
    type === 'snmp' ||
    (type === 'mqtt' && mqttCheckType === 'json-query')
  const registered = React.useMemo(() => new Set(types.map((info) => info.name)), [types])

  // Labels and descriptions come from the catalogue (`monitors.types`, `monitors.typeGroups`).
  const typeGroups = React.useMemo(
    () =>
      Object.entries(MONITOR_TYPE_GROUPS)
        .map(([key, group]) => ({
          key,
          label: tMonitors(`typeGroups.${key as MonitorTypeGroup}`),
          types: group.types
            .filter((option) => types.length === 0 || registered.has(option.name))
            .map((option) => ({
              name: option.name,
              label: tMonitors(`types.${option.name}.label`),
              description: tMonitors(`types.${option.name}.description`),
            })),
        }))
        .filter((g) => g.types.length > 0),
    [types, registered, tMonitors],
  )
  const typeDescription = typeGroups
    .flatMap((g) => g.types)
    .find((t) => t.name === type)?.description

  const otherGroups = groups.filter((g) => String(g.id) !== String(monitorId))

  async function onSubmit(formValues: MonitorFormValues) {
    setPending(true)
    // Without the picker a new monitor gets the organization's default channels (server side).
    let values: Partial<MonitorFormValues> = formValues
    // Rows left over from a type that has assertions are dropped with the type.
    if (!supportsAssertions(formValues.type)) values = { ...values, assertions: [] }
    if (mode === 'create' && !canPickChannels) {
      const { notifications: _omit, ...rest } = values
      values = rest
    }
    try {
      const doc =
        mode === 'create'
          ? await api.post<{ id: string | number }>(`/api/orgs/${orgId}/monitors`, values)
          : await api.patch<{ id: string | number }>(
              `/api/orgs/${orgId}/monitors/${monitorId}`,
              values,
            )
      if (mode === 'create') track('monitor_created', { type: formValues.type })
      toast.success(mode === 'create' ? t('created') : t('saved'))
      router.push(`/${orgSlug}/monitors/${doc.id}`)
      router.refresh()
    } catch (error) {
      setPending(false)
      const issues = responseIssues(error)
      if (issues.length) {
        for (const issue of issues) {
          form.setError(issue.path as Name, { message: issue.message })
        }
        toast.error(t('fixFields'))
      } else {
        toast.error(error instanceof Error ? error.message : t('saveFailed'))
      }
    }
  }

  // "Test": run the unsaved configuration on the worker (`POST /api/orgs/:orgId/checks`).
  const tCheck = useTranslations('monitors.check')
  const [testStartedAt, setTestStartedAt] = React.useState<number | null>(null)
  const [testResult, setTestResult] = React.useState<OnDemandCheckResult | null>(null)
  const testing = testStartedAt !== null
  const testSeconds = useElapsedSeconds(testStartedAt)
  const canTest = supportsAdhocTest(type)

  async function runTest(formValues: MonitorFormValues) {
    setTestStartedAt(Date.now())
    setTestResult(null)
    try {
      setTestResult(await api.post<OnDemandCheckResult>(`/api/orgs/${orgId}/checks`, formValues))
    } catch (error) {
      const issues = responseIssues(error)
      for (const issue of issues) form.setError(issue.path as Name, { message: issue.message })
      toast.error(
        issues.length ? t('fixFields') : error instanceof Error ? error.message : tCheck('failed'),
      )
    } finally {
      setTestStartedAt(null)
    }
  }

  const timingHint = (seconds: unknown) =>
    typeof seconds === 'number' && Number.isFinite(seconds)
      ? humanDuration(seconds, (unit, count) => tDuration(unit, { count }))
      : undefined

  return (
    <Form {...form}>
      <form
        onSubmit={form.handleSubmit(onSubmit)}
        className="mx-auto flex w-full max-w-3xl flex-col gap-6"
        noValidate
        data-testid="monitor-form"
      >
        {/* General ------------------------------------------------------------------------- */}
        <Card>
          <CardHeader>
            <CardTitle>{t('general.title')}</CardTitle>
            <CardDescription>{t('general.description')}</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-5">
            <FormField
              control={control}
              name="type"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('general.type')}</FormLabel>
                  <Select
                    value={field.value}
                    onValueChange={(value) => {
                      field.onChange(value)
                      applyTypeDefaults(
                        value as MonitorTypeName,
                        (n) => getValues(n),
                        (n, v) => setValue(n, v as never, { shouldDirty: true }),
                      )
                    }}
                  >
                    <FormControl>
                      <SelectTrigger className="w-full" data-testid="monitor-type">
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {typeGroups.map((group) => (
                        <SelectGroup key={group.key}>
                          <SelectLabel>{group.label}</SelectLabel>
                          {group.types.map((t) => (
                            <SelectItem key={t.name} value={t.name}>
                              {t.label}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      ))}
                    </SelectContent>
                  </Select>
                  {typeDescription && <FormDescription>{typeDescription}</FormDescription>}
                  <FormMessage />
                </FormItem>
              )}
            />

            <TextField
              control={control}
              name="name"
              label={t('general.name')}
              placeholder={t('general.namePlaceholder')}
              autoComplete="off"
            />

            {isUrl && (
              <TextField
                control={control}
                name="url"
                label={t('general.url')}
                type="url"
                placeholder={
                  isWebSocket ? 'wss://example.com/socket' : 'https://example.com/health'
                }
                autoComplete="off"
              />
            )}

            {isHost && (
              <div className={isPort ? 'grid gap-5 sm:grid-cols-[1fr_8rem]' : 'grid gap-5'}>
                <TextField
                  control={control}
                  name="hostname"
                  label={t('general.hostname')}
                  placeholder={type === 'tailscale-ping' ? 'my-node' : 'example.com'}
                  autoComplete="off"
                />
                {isPort && (
                  <NumberField
                    control={control}
                    name="port"
                    label={type === 'dns' ? t('general.resolverPort') : t('general.port')}
                    min={1}
                    max={65535}
                  />
                )}
              </div>
            )}

            {isKeywordMonitorType(type) && (
              <>
                <TextField
                  control={control}
                  name="keyword"
                  label={t('general.keyword')}
                  description={t('general.keywordDescription')}
                />
                <SwitchField
                  control={control}
                  name="invertKeyword"
                  label={t('general.invertKeyword')}
                  description={t('general.invertKeywordDescription')}
                />
              </>
            )}

            {showsJsonQuery && (
              <>
                <TextField
                  control={control}
                  name="jsonPath"
                  label={
                    type === 'json-query' || type === 'mqtt'
                      ? t('general.jsonQuery')
                      : t('general.jsonQueryOptional')
                  }
                  placeholder="$.status"
                  description={t.rich('general.jsonQueryDescription', {
                    code: (chunks) => <code>{chunks}</code>,
                  })}
                />
                <div className="grid gap-5 sm:grid-cols-[10rem_1fr]">
                  <SelectField
                    control={control}
                    name="jsonPathOperator"
                    label={t('general.condition')}
                    options={JSON_PATH_OPERATORS.map((op) => ({ value: op, label: op }))}
                  />
                  <TextField
                    control={control}
                    name="expectedValue"
                    label={
                      type === 'mongodb' || type === 'snmp'
                        ? t('general.expectedValueOptional')
                        : t('general.expectedValue')
                    }
                  />
                </div>
              </>
            )}

            {type === 'dns' && (
              <div className="grid gap-5 sm:grid-cols-2">
                <TextField
                  control={control}
                  name="dnsResolveServer"
                  label={t('general.resolverServer')}
                  placeholder="1.1.1.1"
                  description={t('general.resolverServerDescription')}
                />
                <SelectField
                  control={control}
                  name="dnsResolveType"
                  label={t('general.recordType')}
                  options={DNS_RECORD_TYPES.map((t) => ({ value: t, label: t }))}
                />
              </div>
            )}

            {type === 'manual' && (
              <SelectField
                control={control}
                name="manualStatus"
                label={t('general.manualStatus')}
                description={t('general.manualStatusDescription')}
                options={MANUAL_STATUSES.map((s) => ({
                  value: s,
                  label: t(`general.manualStatusOption.${s}`),
                }))}
              />
            )}

            {type === 'docker' && (
              <div className="grid gap-5 sm:grid-cols-2">
                <RelationSelectField
                  control={control}
                  name="dockerHost"
                  label={t('general.dockerHost')}
                  noneLabel={null}
                  options={resources.dockerHosts.map((h) => ({ id: h.id, label: h.name }))}
                  description={
                    resources.dockerHosts.length === 0
                      ? t.rich('general.dockerHostEmpty', {
                          link: (chunks) => (
                            <Link
                              href={`/${orgSlug}/settings/docker-hosts`}
                              className="underline underline-offset-2"
                            >
                              {chunks}
                            </Link>
                          ),
                        })
                      : undefined
                  }
                />
                <TextField
                  control={control}
                  name="dockerContainer"
                  label={t('general.dockerContainer')}
                  placeholder="my-app"
                  autoComplete="off"
                />
              </div>
            )}

            {type === 'push' && (
              <p className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground">
                {t('general.push')}
              </p>
            )}

            <FormField
              control={control}
              name="parent"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('general.group')}</FormLabel>
                  <Select
                    value={
                      field.value === null || field.value === undefined ? NONE : String(field.value)
                    }
                    onValueChange={(value) => {
                      if (value === NONE) return field.onChange(null)
                      const match = otherGroups.find((g) => String(g.id) === value)
                      field.onChange(match ? match.id : value)
                    }}
                  >
                    <FormControl>
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value={NONE}>{t('none')}</SelectItem>
                      {otherGroups.map((g) => (
                        <SelectItem key={String(g.id)} value={String(g.id)}>
                          {g.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormDescription>
                    {otherGroups.length === 0
                      ? t('general.groupEmpty')
                      : t('general.groupDescription')}
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <TextField
              control={control}
              name="publicName"
              label={t('general.publicName')}
              description={t('general.publicNameDescription')}
              autoComplete="off"
            />

            <TextareaField
              control={control}
              name="description"
              label={t('general.descriptionLabel')}
              rows={3}
              placeholder={t('general.descriptionPlaceholder')}
            />

            <TagsField control={control} tags={resources.tags} orgSlug={orgSlug} />
          </CardContent>
        </Card>

        {/* Timing -------------------------------------------------------------------------- */}
        {type !== 'group' && type !== 'manual' && (
          <Card>
            <CardHeader>
              <CardTitle>{t('timing.title')}</CardTitle>
              <CardDescription>{t('timing.description')}</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-5 sm:grid-cols-2">
              <NumberField
                control={control}
                name="interval"
                label={t('timing.interval')}
                unit={t('timing.seconds')}
                min={20}
                description={
                  timingHint(interval)
                    ? t('timing.intervalHint', { duration: timingHint(interval) ?? '' })
                    : undefined
                }
              />
              <NumberField
                control={control}
                name="maxRetries"
                label={t('timing.retries')}
                min={0}
                description={t('timing.retriesDescription')}
              />
              <NumberField
                control={control}
                name="retryInterval"
                label={t('timing.retryInterval')}
                unit={t('timing.seconds')}
                min={20}
                description={
                  timingHint(retryInterval)
                    ? t('timing.retryIntervalHint', { duration: timingHint(retryInterval) ?? '' })
                    : undefined
                }
              />
              <NumberField
                control={control}
                name="resendInterval"
                label={t('timing.resend')}
                min={0}
                description={
                  typeof resendInterval === 'number' && resendInterval > 0
                    ? t('timing.resendHint', { count: resendInterval })
                    : t('timing.resendDescription')
                }
              />
              {type !== 'push' && (
                <NumberField
                  control={control}
                  name="timeout"
                  label={t('timing.timeout')}
                  unit={t('timing.seconds')}
                  min={0}
                  step={0.1}
                  description={
                    typeof timeout === 'number' && timeout === 0
                      ? t('timing.timeoutDefault')
                      : timingHint(timeout)
                  }
                />
              )}
              {supportsDegradedThreshold(type) && (
                <NumberField
                  control={control}
                  name="degradedAfter"
                  label={t('timing.degradedAfter')}
                  unit={t('timing.milliseconds')}
                  min={0}
                  step={1}
                  description={t('timing.degradedAfterDescription')}
                />
              )}
            </CardContent>
          </Card>
        )}

        {/* Connection (databases, protocols, game servers) --------------------------------- */}
        {hasConnectionSection(type) && (
          <Card>
            <CardHeader>
              <CardTitle>{t('connection.title')}</CardTitle>
              <CardDescription>{t('connection.description')}</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-5">
              {isDatabase && (
                <>
                  <TextField
                    control={control}
                    name="databaseConnectionString"
                    label={t('connection.connectionString')}
                    placeholder={DATABASE_CONNECTION_PLACEHOLDERS[type as string]}
                    autoComplete="off"
                    description={t('connection.connectionStringDescription')}
                  />
                  {type !== 'redis' && (
                    <TextareaField
                      control={control}
                      name="databaseQuery"
                      label={type === 'mongodb' ? t('connection.command') : t('connection.query')}
                      mono
                      rows={3}
                      // eslint-disable-next-line marmot/no-literal-jsx-text -- example value, not prose
                      placeholder={type === 'mongodb' ? '{"ping": 1}' : 'SELECT 1'}
                      description={
                        type === 'mongodb'
                          ? t('connection.commandDescription', { example: '{"ping": 1}' })
                          : t('connection.queryDescription')
                      }
                    />
                  )}
                  {type === 'redis' && (
                    <SwitchField
                      control={control}
                      name="ignoreTls"
                      label={t('connection.ignoreTls')}
                      description={t('connection.redisIgnoreTlsDescription')}
                    />
                  )}
                </>
              )}

              {type === 'mqtt' && (
                <>
                  <TextField
                    control={control}
                    name="mqttTopic"
                    label={t('connection.topic')}
                    placeholder="sensors/+/status"
                  />
                  <div className="grid gap-5 sm:grid-cols-2">
                    <TextField
                      control={control}
                      name="mqttUsername"
                      label={t('connection.username')}
                      autoComplete="off"
                    />
                    <TextField
                      control={control}
                      name="mqttPassword"
                      label={t('connection.password')}
                      type="password"
                      autoComplete="new-password"
                    />
                  </div>
                  <SelectField
                    control={control}
                    name="mqttCheckType"
                    label={t('connection.checkType')}
                    options={MQTT_CHECK_TYPES.map((checkType) => ({
                      value: checkType,
                      label: t(`connection.checkTypeOption.${checkType}`),
                    }))}
                  />
                  {mqttCheckType !== 'json-query' && (
                    <TextField
                      control={control}
                      name="mqttSuccessMessage"
                      label={t('connection.successMessage')}
                      description={t('connection.successMessageDescription')}
                    />
                  )}
                </>
              )}

              {type === 'kafka-producer' && (
                <>
                  <ListField
                    control={control}
                    name="kafkaProducerBrokers"
                    label={t('connection.brokers')}
                    placeholder={'kafka1:9092\nkafka2:9092'}
                    description={t('connection.brokersDescription')}
                  />
                  <TextField
                    control={control}
                    name="kafkaProducerTopic"
                    label={t('connection.topic')}
                  />
                  <TextareaField
                    control={control}
                    name="kafkaProducerMessage"
                    label={t('connection.message')}
                    rows={2}
                    // eslint-disable-next-line marmot/no-literal-jsx-text -- example value, not prose
                    placeholder="marmot heartbeat"
                  />
                  <div className="grid gap-3 sm:grid-cols-2">
                    <SwitchField
                      control={control}
                      name="kafkaProducerSsl"
                      label={t('connection.enableSsl')}
                      description={t('connection.enableSslDescription')}
                    />
                    <SwitchField
                      control={control}
                      name="kafkaProducerAllowAutoTopicCreation"
                      label={t('connection.autoTopic')}
                      description={t('connection.autoTopicDescription')}
                    />
                  </div>
                  <TextareaField
                    control={control}
                    name="kafkaProducerSaslOptions"
                    label={t('connection.saslOptions')}
                    mono
                    rows={3}
                    placeholder={
                      '{\n  "mechanism": "plain",\n  "username": "…",\n  "password": "…"\n}'
                    }
                    description={t('connection.saslOptionsDescription')}
                  />
                </>
              )}

              {type === 'grpc-keyword' && (
                <>
                  <TextField
                    control={control}
                    name="grpcUrl"
                    label={t('connection.grpcUrl')}
                    placeholder="api.example.com:443"
                    description={t('connection.grpcUrlDescription')}
                  />
                  <div className="grid gap-5 sm:grid-cols-2">
                    <TextField
                      control={control}
                      name="grpcServiceName"
                      label={t('connection.serviceName')}
                      placeholder="health.v1.Health"
                    />
                    <TextField
                      control={control}
                      name="grpcMethod"
                      label={t('connection.method')}
                      placeholder="check"
                      description={t('connection.methodDescription')}
                    />
                  </div>
                  <SwitchField
                    control={control}
                    name="grpcEnableTls"
                    label={t('connection.enableTls')}
                    description={t('connection.enableTlsDescription')}
                  />
                  <TextareaField
                    control={control}
                    name="grpcProtobuf"
                    label={t('connection.protobuf')}
                    mono
                    rows={8}
                    placeholder={
                      'syntax = "proto3";\n\npackage health.v1;\n\nservice Health {\n  rpc Check (HealthCheckRequest) returns (HealthCheckResponse);\n}'
                    }
                  />
                  <TextareaField
                    control={control}
                    name="grpcBody"
                    label={t('connection.requestBody')}
                    mono
                    rows={3}
                    placeholder={'{\n  "service": "api"\n}'}
                    description={t('connection.requestBodyDescription')}
                  />
                  <TextareaField
                    control={control}
                    name="grpcMetadata"
                    label={t('connection.metadata')}
                    mono
                    rows={2}
                    placeholder={'{\n  "authorization": "Bearer …"\n}'}
                    description={t('connection.metadataDescription')}
                  />
                </>
              )}

              {type === 'radius' && (
                <>
                  <div className="grid gap-5 sm:grid-cols-3">
                    <TextField
                      control={control}
                      name="radiusUsername"
                      label={t('connection.username')}
                      autoComplete="off"
                    />
                    <TextField
                      control={control}
                      name="radiusPassword"
                      label={t('connection.password')}
                      type="password"
                      autoComplete="new-password"
                    />
                    <TextField
                      control={control}
                      name="radiusSecret"
                      label={t('connection.sharedSecret')}
                      type="password"
                      autoComplete="off"
                    />
                  </div>
                  <div className="grid gap-5 sm:grid-cols-2">
                    <TextField
                      control={control}
                      name="radiusCalledStationId"
                      label={t('connection.calledStationId')}
                      description={t('connection.calledStationIdDescription')}
                    />
                    <TextField
                      control={control}
                      name="radiusCallingStationId"
                      label={t('connection.callingStationId')}
                      description={t('connection.callingStationIdDescription')}
                    />
                  </div>
                </>
              )}

              {type === 'snmp' && (
                <div className="grid gap-5 sm:grid-cols-[1fr_9rem_1fr]">
                  <TextField
                    control={control}
                    name="snmpOid"
                    label={t('connection.oid')}
                    placeholder="1.3.6.1.2.1.1.1.0"
                  />
                  <SelectField
                    control={control}
                    name="snmpVersion"
                    label={t('connection.version')}
                    options={SNMP_VERSIONS.map((v) => ({ value: v, label: `SNMPv${v}` }))}
                  />
                  <TextField
                    control={control}
                    name="snmpCommunity"
                    label={t('connection.community')}
                    placeholder="public"
                  />
                </div>
              )}

              {type === 'smtp' && (
                <SelectField
                  control={control}
                  name="smtpSecurity"
                  label={t('connection.security')}
                  options={SMTP_SECURITY_MODES.map((m) => ({
                    value: m,
                    label: t(`connection.smtpSecurity.${m}`),
                  }))}
                  description={t('connection.securityDescription')}
                />
              )}

              {type === 'sftp' && (
                <>
                  <div className="grid gap-5 sm:grid-cols-2">
                    <TextField
                      control={control}
                      name="sshUsername"
                      label={t('connection.username')}
                      autoComplete="off"
                    />
                    <SelectField
                      control={control}
                      name="sshAuthMethod"
                      label={t('connection.authentication')}
                      options={SSH_AUTH_METHODS.map((m) => ({
                        value: m,
                        label: t(`connection.sshAuth.${m}`),
                      }))}
                    />
                  </div>
                  {sshAuthMethod === 'privateKey' ? (
                    <>
                      <TextareaField
                        control={control}
                        name="sshPrivateKey"
                        label={t('connection.privateKey')}
                        mono
                        rows={5}
                      />
                      <TextField
                        control={control}
                        name="sshPassphrase"
                        label={t('connection.passphrase')}
                        type="password"
                        autoComplete="off"
                        description={t('connection.passphraseDescription')}
                      />
                    </>
                  ) : (
                    <TextField
                      control={control}
                      name="sshPassword"
                      label={t('connection.password')}
                      type="password"
                      autoComplete="new-password"
                    />
                  )}
                  <TextField
                    control={control}
                    name="sftpPath"
                    label={t('connection.remotePath')}
                    placeholder="/var/backups"
                    description={t('connection.remotePathDescription')}
                  />
                </>
              )}

              {type === 'rabbitmq' && (
                <>
                  <ListField
                    control={control}
                    name="rabbitmqNodes"
                    label={t('connection.nodes')}
                    placeholder={
                      'https://node1.rabbitmq.example:15672\nhttps://node2.rabbitmq.example:15672'
                    }
                    description={t('connection.nodesDescription')}
                  />
                  <div className="grid gap-5 sm:grid-cols-2">
                    <TextField
                      control={control}
                      name="rabbitmqUsername"
                      label={t('connection.username')}
                      autoComplete="off"
                    />
                    <TextField
                      control={control}
                      name="rabbitmqPassword"
                      label={t('connection.password')}
                      type="password"
                      autoComplete="new-password"
                    />
                  </div>
                </>
              )}

              {isWebSocket && (
                <>
                  <StatusCodesField
                    control={control}
                    label={t('connection.closeCodes')}
                    description={t.rich('connection.closeCodesDescription', {
                      code: (chunks) => <code>{chunks}</code>,
                    })}
                  />
                  <TextareaField
                    control={control}
                    name="headers"
                    label={t('connection.headers')}
                    mono
                    placeholder={'{\n  "Origin": "https://example.com"\n}'}
                    description={t('connection.wsHeadersDescription')}
                  />
                  <TextField
                    control={control}
                    name="wsSubprotocol"
                    label={t('connection.subprotocols')}
                    // eslint-disable-next-line marmot/no-literal-jsx-text -- example value, not prose
                    placeholder="graphql-ws, mqtt"
                    description={t('connection.subprotocolsDescription')}
                  />
                  <div className="grid gap-3 sm:grid-cols-2">
                    <SwitchField
                      control={control}
                      name="wsIgnoreSecWebsocketAcceptHeader"
                      label={t('connection.ignoreAcceptHeader')}
                      description={t('connection.ignoreAcceptHeaderDescription')}
                    />
                    <SwitchField
                      control={control}
                      name="ignoreTls"
                      label={t('connection.ignoreTls')}
                      description={t('connection.ignoreTlsDescription')}
                    />
                  </div>
                </>
              )}

              {type === 'gamedig' && (
                <>
                  <TextField
                    control={control}
                    name="game"
                    label={t('connection.game')}
                    placeholder="minecraft"
                    description={t.rich('connection.gameDescription', {
                      link: (chunks) => (
                        <a
                          className="underline"
                          href="https://github.com/gamedig/node-gamedig/blob/master/GAMES_LIST.md"
                          target="_blank"
                          rel="noreferrer"
                        >
                          {chunks}
                        </a>
                      ),
                    })}
                  />
                  <SwitchField
                    control={control}
                    name="gamedigGivenPortOnly"
                    label={t('connection.givenPortOnly')}
                    description={t('connection.givenPortOnlyDescription')}
                  />
                </>
              )}

              {type === 'steam' && (
                <p className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground">
                  {t('connection.steam')}
                </p>
              )}

              {type === 'real-browser' && (
                <>
                  <TextField
                    control={control}
                    name="remoteBrowser"
                    label={t('connection.remoteBrowser')}
                    placeholder="ws://browserless:3000"
                    description={t('connection.remoteBrowserDescription')}
                  />
                  <SwitchField
                    control={control}
                    name="ignoreTls"
                    label={t('connection.ignoreTls')}
                    description={t('connection.ignoreTlsDescription')}
                  />
                </>
              )}
            </CardContent>
          </Card>
        )}

        {/* HTTP options -------------------------------------------------------------------- */}
        {isHttp && (
          <Card>
            <CardHeader>
              <CardTitle>{t('http.title')}</CardTitle>
              <CardDescription>{t('http.description')}</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-5">
              <div className="grid gap-5 sm:grid-cols-3">
                <SelectField
                  control={control}
                  name="method"
                  label={t('http.method')}
                  options={HTTP_METHODS.map((m) => ({ value: m, label: m }))}
                />
                <SelectField
                  control={control}
                  name="httpBodyEncoding"
                  label={t('http.bodyEncoding')}
                  options={BODY_ENCODINGS.map((e) => ({
                    value: e,
                    label: t(`http.encoding.${e}`),
                  }))}
                />
                <NumberField
                  control={control}
                  name="maxRedirects"
                  label={t('http.maxRedirects')}
                  min={0}
                />
              </div>
              <TextareaField
                control={control}
                name="body"
                label={t('http.body')}
                mono
                placeholder={
                  httpBodyEncoding === 'json'
                    ? '{\n  "key": "value"\n}'
                    : httpBodyEncoding === 'form'
                      ? 'key=value&other=1'
                      : '<request/>'
                }
              />
              <TextareaField
                control={control}
                name="headers"
                label={t('http.headers')}
                mono
                placeholder={'{\n  "Authorization": "Token abc"\n}'}
                description={t('http.headersDescription')}
              />
              <StatusCodesField control={control} />
              <RelationSelectField
                control={control}
                name="proxy"
                label={t('http.proxy')}
                noneLabel={t('http.noProxy')}
                options={resources.proxies.map((p) => {
                  const label = p.isDefault ? t('http.proxyDefault', { label: p.label }) : p.label
                  return { id: p.id, label: p.active ? label : t('http.proxyInactive', { label }) }
                })}
                description={
                  resources.proxies.length === 0
                    ? t.rich('http.proxyEmpty', {
                        link: (chunks) => (
                          <Link
                            href={`/${orgSlug}/settings/proxies`}
                            className="underline underline-offset-2"
                          >
                            {chunks}
                          </Link>
                        ),
                      })
                    : t('http.proxyDescription')
                }
              />
              <SwitchField
                control={control}
                name="ignoreTls"
                label={t('http.ignoreTls')}
                description={t('http.ignoreTlsDescription')}
              />
            </CardContent>
          </Card>
        )}

        {/* Assertions ---------------------------------------------------------------------- */}
        {supportsAssertions(type) && (
          <Card>
            <CardHeader>
              <CardTitle>{t('assertions.title')}</CardTitle>
              <CardDescription>
                {type === 'dns' ? t('assertions.descriptionDns') : t('assertions.description')}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <AssertionsField
                control={control}
                setValue={setValue}
                monitorType={type}
                dnsRecordType={dnsResolveType}
              />
            </CardContent>
          </Card>
        )}

        {/* Authentication ------------------------------------------------------------------ */}
        {(isHttp || isWebSocket) && (
          <Card>
            <CardHeader>
              <CardTitle>{t('auth.title')}</CardTitle>
              <CardDescription>{t('auth.description')}</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-5">
              <SelectField
                control={control}
                name="authMethod"
                label={t('auth.method')}
                options={(isWebSocket ? WS_AUTH_METHODS : AUTH_METHODS).map((m) => ({
                  value: m,
                  label: t(`auth.methods.${m}`),
                }))}
              />
              {(authMethod === 'basic' || authMethod === 'ntlm') && (
                <div className="grid gap-5 sm:grid-cols-2">
                  <TextField
                    control={control}
                    name="basicAuthUser"
                    label={t('auth.username')}
                    autoComplete="off"
                  />
                  <TextField
                    control={control}
                    name="basicAuthPass"
                    label={t('auth.password')}
                    type="password"
                    autoComplete="new-password"
                  />
                </div>
              )}
              {authMethod === 'ntlm' && (
                <div className="grid gap-5 sm:grid-cols-2">
                  <TextField control={control} name="authDomain" label={t('auth.domain')} />
                  <TextField
                    control={control}
                    name="authWorkstation"
                    label={t('auth.workstation')}
                  />
                </div>
              )}
              {authMethod === 'bearer' && (
                <TextField
                  control={control}
                  name="bearerToken"
                  label={t('auth.token')}
                  type="password"
                  autoComplete="off"
                  description={t('auth.tokenDescription', {
                    header: 'Authorization: Bearer <token>',
                  })}
                />
              )}
              {authMethod === 'oauth2-cc' && (
                <>
                  <TextField
                    control={control}
                    name="oauthTokenUrl"
                    label={t('auth.tokenUrl')}
                    type="url"
                    placeholder="https://auth.example.com/oauth/token"
                  />
                  <div className="grid gap-5 sm:grid-cols-2">
                    <TextField control={control} name="oauthClientId" label={t('auth.clientId')} />
                    <TextField
                      control={control}
                      name="oauthClientSecret"
                      label={t('auth.clientSecret')}
                      type="password"
                      autoComplete="off"
                    />
                  </div>
                  <div className="grid gap-5 sm:grid-cols-2">
                    <TextField
                      control={control}
                      name="oauthScopes"
                      label={t('auth.scopes')}
                      // eslint-disable-next-line marmot/no-literal-jsx-text -- example value, not prose
                      placeholder="read write"
                    />
                    <SelectField
                      control={control}
                      name="oauthAuthMethod"
                      label={t('auth.clientAuthentication')}
                      options={OAUTH_AUTH_METHODS.map((m) => ({
                        value: m,
                        label: t(`auth.clientAuth.${m}`),
                      }))}
                    />
                  </div>
                </>
              )}
              {authMethod === 'mtls' && (
                <>
                  <TextareaField
                    control={control}
                    name="tlsCert"
                    label={t('auth.clientCertificate')}
                    mono
                    rows={5}
                  />
                  <TextareaField
                    control={control}
                    name="tlsKey"
                    label={t('auth.privateKey')}
                    mono
                    rows={5}
                  />
                  <TextareaField
                    control={control}
                    name="tlsCa"
                    label={t('auth.caCertificate')}
                    mono
                    rows={5}
                  />
                </>
              )}
            </CardContent>
          </Card>
        )}

        {/* Notifications ------------------------------------------------------------------- */}
        {canPickChannels && (
          <Card>
            <CardHeader>
              <CardTitle>{tChannels('title')}</CardTitle>
              <CardDescription>{tChannels('description')}</CardDescription>
            </CardHeader>
            <CardContent>
              <NotificationPicker
                control={control}
                channels={resources.notifications}
                orgSlug={orgSlug}
              />
            </CardContent>
          </Card>
        )}

        {/* Advanced ------------------------------------------------------------------------ */}
        {type !== 'group' && (
          <Card>
            <CardHeader>
              <CardTitle>{t('advanced.title')}</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-3">
              <SwitchField
                control={control}
                name="upsideDown"
                label={t('advanced.upsideDown')}
                description={t('advanced.upsideDownDescription')}
              />
              {isHttp && (
                <SwitchField
                  control={control}
                  name="expiryNotification"
                  label={t('advanced.certExpiry')}
                  description={t('advanced.certExpiryDescription')}
                />
              )}
              {(isHttp || isHost) && (
                <SwitchField
                  control={control}
                  name="domainExpiryNotification"
                  label={t('advanced.domainExpiry')}
                  description={t('advanced.domainExpiryDescription')}
                />
              )}
              <SwitchField
                control={control}
                name="active"
                label={t('advanced.active')}
                description={t('advanced.activeDescription')}
              />
            </CardContent>
          </Card>
        )}

        {(testing || testResult) && (
          <Card data-testid="monitor-test-panel" aria-live="polite">
            <CardHeader>
              <CardTitle>{tCheck('testTitle')}</CardTitle>
              <CardDescription>{tCheck('testDescription')}</CardDescription>
            </CardHeader>
            <CardContent>
              {testing ? (
                <p className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" aria-hidden />
                  {tCheck('testRunning', { seconds: testSeconds })}
                </p>
              ) : (
                testResult && <CheckResultView result={testResult} />
              )}
            </CardContent>
          </Card>
        )}

        <div className="flex items-center justify-end gap-2">
          {canTest && (
            <Button
              type="button"
              variant="outline"
              className="mr-auto"
              disabled={pending || testing}
              onClick={() => void form.handleSubmit(runTest, () => toast.error(t('fixFields')))()}
              data-testid="monitor-test"
            >
              {testing ? <Loader2 className="animate-spin" aria-hidden /> : <FlaskConical />}
              {testing ? tCheck('testing', { seconds: testSeconds }) : tCheck('test')}
            </Button>
          )}
          <Button variant="ghost" asChild disabled={pending}>
            <Link
              href={
                mode === 'edit' && monitorId
                  ? `/${orgSlug}/monitors/${monitorId}`
                  : `/${orgSlug}/monitors`
              }
            >
              {t('cancel')}
            </Link>
          </Button>
          <Button type="submit" disabled={pending} data-testid="monitor-submit">
            {pending && <Loader2 className="animate-spin" />}
            {mode === 'create' ? t('create') : t('save')}
          </Button>
        </div>
      </form>
    </Form>
  )
}
