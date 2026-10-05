'use client'

import { zodResolver } from '@hookform/resolvers/zod'
import { Loader2, X } from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
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
import { api, ApiError } from '@/lib/api'
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
  monitorFormSchema,
  MQTT_CHECK_TYPES,
  SMTP_SECURITY_MODES,
  SNMP_VERSIONS,
  SSH_AUTH_METHODS,
  type MonitorFormInput,
  type MonitorFormValues,
  type MonitorTypeName,
} from '@/lib/validation/monitor'

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
}

type Name = FieldPath<MonitorFormInput>
type FormControlType = Control<MonitorFormInput, unknown, MonitorFormValues>

const NONE = '__none__'

const AUTH_LABELS: Record<(typeof AUTH_METHODS)[number], string> = {
  none: 'None',
  basic: 'HTTP Basic',
  bearer: 'Bearer token',
  'oauth2-cc': 'OAuth2 client credentials',
  ntlm: 'NTLM',
  mtls: 'mTLS (client certificate)',
}

const ENCODING_LABELS: Record<(typeof BODY_ENCODINGS)[number], string> = {
  json: 'JSON',
  form: 'Form (x-www-form-urlencoded)',
  xml: 'XML',
}

const SMTP_SECURITY_LABELS: Record<(typeof SMTP_SECURITY_MODES)[number], string> = {
  opportunistic: 'STARTTLS if offered',
  starttls: 'Require STARTTLS',
  secure: 'SMTPS (implicit TLS)',
  nostarttls: 'Ignore STARTTLS',
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
            <FormDescription>{description ?? 'One per line.'}</FormDescription>
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
  label = 'Accepted status codes',
  description,
}: {
  control: FormControlType
  label?: string
  description?: React.ReactNode
}) {
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
            <FormLabel>{label}</FormLabel>
            <FormControl>
              <div className="flex min-h-9 flex-wrap items-center gap-1.5 rounded-md border border-input px-2 py-1 shadow-xs focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50 dark:bg-input/30">
                {codes.map((code) => (
                  <Badge key={code} variant="secondary" className="gap-1 pr-1 font-mono">
                    {code}
                    <button
                      type="button"
                      aria-label={`Remove ${code}`}
                      className="rounded-full p-0.5 hover:bg-foreground/10"
                      onClick={() => field.onChange(codes.filter((c) => c !== code))}
                    >
                      <X className="size-3" />
                    </button>
                  </Badge>
                ))}
                <input
                  aria-label="Add status code"
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
              {description ?? (
                <>
                  Codes or ranges counted as UP, e.g. <code>200-299</code>, <code>304</code>.
                </>
              )}
            </FormDescription>
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
}: MonitorFormProps) {
  const router = useRouter()
  const [pending, setPending] = React.useState(false)

  const form = useForm<MonitorFormInput, unknown, MonitorFormValues>({
    resolver: zodResolver(monitorFormSchema),
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
  const registered = React.useMemo(() => new Map(types.map((t) => [t.name, t.label])), [types])

  const typeGroups = React.useMemo(
    () =>
      Object.entries(MONITOR_TYPE_GROUPS)
        .map(([key, group]) => ({
          key,
          label: group.label,
          types: group.types
            .filter((t) => types.length === 0 || registered.has(t.name))
            .map((t) => ({ ...t, label: registered.get(t.name) ?? t.label })),
        }))
        .filter((g) => g.types.length > 0),
    [types, registered],
  )
  const typeDescription = typeGroups
    .flatMap((g) => g.types)
    .find((t) => t.name === type)?.description

  const otherGroups = groups.filter((g) => String(g.id) !== String(monitorId))

  async function onSubmit(values: MonitorFormValues) {
    setPending(true)
    try {
      const doc =
        mode === 'create'
          ? await api.post<{ id: string | number }>(`/api/orgs/${orgId}/monitors`, values)
          : await api.patch<{ id: string | number }>(
              `/api/orgs/${orgId}/monitors/${monitorId}`,
              values,
            )
      toast.success(mode === 'create' ? 'Monitor created' : 'Monitor saved')
      router.push(`/${orgSlug}/monitors/${doc.id}`)
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
        for (const issue of issues) {
          form.setError(issue.path as Name, { message: issue.message })
        }
        toast.error('Please fix the highlighted fields')
      } else {
        toast.error(error instanceof Error ? error.message : 'Could not save the monitor')
      }
    }
  }

  const timingHint = (seconds: unknown) =>
    typeof seconds === 'number' && Number.isFinite(seconds) ? humanDuration(seconds) : undefined

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
            <CardTitle>General</CardTitle>
            <CardDescription>What to watch and how it shows up in the list.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-5">
            <FormField
              control={control}
              name="type"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Monitor type</FormLabel>
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
              label="Friendly name"
              placeholder="Marketing site"
              autoComplete="off"
            />

            {isUrl && (
              <TextField
                control={control}
                name="url"
                label="URL"
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
                  label="Hostname"
                  placeholder={type === 'tailscale-ping' ? 'my-node' : 'example.com'}
                  autoComplete="off"
                />
                {isPort && (
                  <NumberField
                    control={control}
                    name="port"
                    label={type === 'dns' ? 'Resolver port' : 'Port'}
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
                  label="Keyword"
                  description="Searched in the response (case-sensitive)."
                />
                <SwitchField
                  control={control}
                  name="invertKeyword"
                  label="Invert keyword"
                  description="UP when the keyword is absent."
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
                      ? 'JSON query'
                      : 'JSON query (optional)'
                  }
                  placeholder="$.status"
                  description={
                    <>
                      JSONata expression evaluated against the result, e.g. <code>data[0].ok</code>.
                    </>
                  }
                />
                <div className="grid gap-5 sm:grid-cols-[10rem_1fr]">
                  <SelectField
                    control={control}
                    name="jsonPathOperator"
                    label="Condition"
                    options={JSON_PATH_OPERATORS.map((op) => ({ value: op, label: op }))}
                  />
                  <TextField
                    control={control}
                    name="expectedValue"
                    label={
                      type === 'mongodb' || type === 'snmp'
                        ? 'Expected value (optional)'
                        : 'Expected value'
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
                  label="Resolver server"
                  placeholder="1.1.1.1"
                  description="Comma-separated IPs or hostnames."
                />
                <SelectField
                  control={control}
                  name="dnsResolveType"
                  label="Record type"
                  options={DNS_RECORD_TYPES.map((t) => ({ value: t, label: t }))}
                />
              </div>
            )}

            {type === 'manual' && (
              <SelectField
                control={control}
                name="manualStatus"
                label="Status to report"
                description="Manual monitors are never checked; they show the status you set."
                options={MANUAL_STATUSES.map((s) => ({
                  value: s,
                  label: s[0].toUpperCase() + s.slice(1),
                }))}
              />
            )}

            {type === 'push' && (
              <p className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground">
                A push URL is generated when the monitor is saved. Call it at least every interval;
                a missed call marks the monitor DOWN.
              </p>
            )}

            <FormField
              control={control}
              name="parent"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Monitor group</FormLabel>
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
                      <SelectItem value={NONE}>None</SelectItem>
                      {otherGroups.map((g) => (
                        <SelectItem key={String(g.id)} value={String(g.id)}>
                          {g.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormDescription>
                    {otherGroups.length === 0
                      ? 'Create a Group monitor to nest monitors under it.'
                      : 'Groups aggregate the status of their children.'}
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <TextareaField
              control={control}
              name="description"
              label="Description"
              rows={3}
              placeholder="Shown on the detail page and status pages."
            />

            <FormItem>
              <FormLabel className="text-muted-foreground">Tags</FormLabel>
              <Input disabled placeholder="Tags arrive with the tags & proxies release" />
              <FormDescription>
                Tag monitors to filter the list and group status pages.
              </FormDescription>
            </FormItem>
          </CardContent>
        </Card>

        {/* Timing -------------------------------------------------------------------------- */}
        {type !== 'group' && type !== 'manual' && (
          <Card>
            <CardHeader>
              <CardTitle>Timing</CardTitle>
              <CardDescription>
                How often to check and how patient to be before alerting.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-5 sm:grid-cols-2">
              <NumberField
                control={control}
                name="interval"
                label="Heartbeat interval"
                unit="seconds"
                min={20}
                description={
                  timingHint(interval) ? `Check every ${timingHint(interval)}` : undefined
                }
              />
              <NumberField
                control={control}
                name="maxRetries"
                label="Retries"
                min={0}
                description="Failed checks before the monitor is marked DOWN."
              />
              <NumberField
                control={control}
                name="retryInterval"
                label="Heartbeat retry interval"
                unit="seconds"
                min={20}
                description={
                  timingHint(retryInterval)
                    ? `Retry every ${timingHint(retryInterval)} while pending`
                    : undefined
                }
              />
              <NumberField
                control={control}
                name="resendInterval"
                label="Resend notification"
                min={0}
                description={
                  typeof resendInterval === 'number' && resendInterval > 0
                    ? `Re-notify every ${resendInterval} consecutive DOWN beats`
                    : 'Every N consecutive DOWN beats (0 = never)'
                }
              />
              {type !== 'push' && (
                <NumberField
                  control={control}
                  name="timeout"
                  label="Request timeout"
                  unit="seconds"
                  min={0}
                  step={0.1}
                  description={
                    typeof timeout === 'number' && timeout === 0
                      ? '0 uses 80% of the interval'
                      : timingHint(timeout)
                  }
                />
              )}
            </CardContent>
          </Card>
        )}

        {/* Connection (databases, protocols, game servers) --------------------------------- */}
        {hasConnectionSection(type) && (
          <Card>
            <CardHeader>
              <CardTitle>Connection</CardTitle>
              <CardDescription>How to reach the service and what to ask it.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-5">
              {isDatabase && (
                <>
                  <TextField
                    control={control}
                    name="databaseConnectionString"
                    label="Connection string"
                    placeholder={DATABASE_CONNECTION_PLACEHOLDERS[type as string]}
                    autoComplete="off"
                    description="Credentials are stored with the monitor; use a read-only account."
                  />
                  {type !== 'redis' && (
                    <TextareaField
                      control={control}
                      name="databaseQuery"
                      label={type === 'mongodb' ? 'Command' : 'Query'}
                      mono
                      rows={3}
                      placeholder={type === 'mongodb' ? '{"ping": 1}' : 'SELECT 1'}
                      description={
                        type === 'mongodb'
                          ? 'JSON command document run against the database (default {"ping": 1}).'
                          : 'Statement that must succeed (default SELECT 1).'
                      }
                    />
                  )}
                  {type === 'redis' && (
                    <SwitchField
                      control={control}
                      name="ignoreTls"
                      label="Ignore TLS errors"
                      description="Accept self-signed certificates on rediss:// connections."
                    />
                  )}
                </>
              )}

              {type === 'mqtt' && (
                <>
                  <TextField
                    control={control}
                    name="mqttTopic"
                    label="Topic"
                    placeholder="sensors/+/status"
                  />
                  <div className="grid gap-5 sm:grid-cols-2">
                    <TextField
                      control={control}
                      name="mqttUsername"
                      label="Username"
                      autoComplete="off"
                    />
                    <TextField
                      control={control}
                      name="mqttPassword"
                      label="Password"
                      type="password"
                      autoComplete="new-password"
                    />
                  </div>
                  <SelectField
                    control={control}
                    name="mqttCheckType"
                    label="Check type"
                    options={MQTT_CHECK_TYPES.map((t) => ({
                      value: t,
                      label: t === 'keyword' ? 'Keyword' : 'JSON query',
                    }))}
                  />
                  {mqttCheckType !== 'json-query' && (
                    <TextField
                      control={control}
                      name="mqttSuccessMessage"
                      label="Success message"
                      description="The received message must contain this text (leave empty to accept any message)."
                    />
                  )}
                </>
              )}

              {type === 'kafka-producer' && (
                <>
                  <ListField
                    control={control}
                    name="kafkaProducerBrokers"
                    label="Brokers"
                    placeholder={'kafka1:9092\nkafka2:9092'}
                    description="Bootstrap broker addresses, one per line."
                  />
                  <TextField control={control} name="kafkaProducerTopic" label="Topic" />
                  <TextareaField
                    control={control}
                    name="kafkaProducerMessage"
                    label="Message"
                    rows={2}
                    placeholder="marmot heartbeat"
                  />
                  <div className="grid gap-3 sm:grid-cols-2">
                    <SwitchField
                      control={control}
                      name="kafkaProducerSsl"
                      label="Enable SSL"
                      description="Connect to the brokers over TLS."
                    />
                    <SwitchField
                      control={control}
                      name="kafkaProducerAllowAutoTopicCreation"
                      label="Allow auto topic creation"
                      description="Create the topic when it does not exist."
                    />
                  </div>
                  <TextareaField
                    control={control}
                    name="kafkaProducerSaslOptions"
                    label="SASL options"
                    mono
                    rows={3}
                    placeholder={
                      '{\n  "mechanism": "plain",\n  "username": "…",\n  "password": "…"\n}'
                    }
                    description="JSON object: mechanism (plain, scram-sha-256, scram-sha-512), username, password. Leave empty for no authentication."
                  />
                </>
              )}

              {type === 'grpc-keyword' && (
                <>
                  <TextField
                    control={control}
                    name="grpcUrl"
                    label="gRPC URL"
                    placeholder="api.example.com:443"
                    description="host:port without a scheme."
                  />
                  <div className="grid gap-5 sm:grid-cols-2">
                    <TextField
                      control={control}
                      name="grpcServiceName"
                      label="Service name"
                      placeholder="health.v1.Health"
                    />
                    <TextField
                      control={control}
                      name="grpcMethod"
                      label="Method"
                      placeholder="check"
                      description="lowerCamelCase method name of the service."
                    />
                  </div>
                  <SwitchField
                    control={control}
                    name="grpcEnableTls"
                    label="Enable TLS"
                    description="Use TLS credentials for the channel."
                  />
                  <TextareaField
                    control={control}
                    name="grpcProtobuf"
                    label="Proto definition"
                    mono
                    rows={8}
                    placeholder={
                      'syntax = "proto3";\n\npackage health.v1;\n\nservice Health {\n  rpc Check (HealthCheckRequest) returns (HealthCheckResponse);\n}'
                    }
                  />
                  <TextareaField
                    control={control}
                    name="grpcBody"
                    label="Request body"
                    mono
                    rows={3}
                    placeholder={'{\n  "service": "api"\n}'}
                    description="JSON object passed to the method."
                  />
                  <TextareaField
                    control={control}
                    name="grpcMetadata"
                    label="Metadata"
                    mono
                    rows={2}
                    placeholder={'{\n  "authorization": "Bearer …"\n}'}
                    description="JSON object of request metadata (optional)."
                  />
                </>
              )}

              {type === 'radius' && (
                <>
                  <div className="grid gap-5 sm:grid-cols-3">
                    <TextField
                      control={control}
                      name="radiusUsername"
                      label="Username"
                      autoComplete="off"
                    />
                    <TextField
                      control={control}
                      name="radiusPassword"
                      label="Password"
                      type="password"
                      autoComplete="new-password"
                    />
                    <TextField
                      control={control}
                      name="radiusSecret"
                      label="Shared secret"
                      type="password"
                      autoComplete="off"
                    />
                  </div>
                  <div className="grid gap-5 sm:grid-cols-2">
                    <TextField
                      control={control}
                      name="radiusCalledStationId"
                      label="Called station id"
                      description="Identifier of the called device (optional)."
                    />
                    <TextField
                      control={control}
                      name="radiusCallingStationId"
                      label="Calling station id"
                      description="Identifier of the calling device (optional)."
                    />
                  </div>
                </>
              )}

              {type === 'snmp' && (
                <div className="grid gap-5 sm:grid-cols-[1fr_9rem_1fr]">
                  <TextField
                    control={control}
                    name="snmpOid"
                    label="OID"
                    placeholder="1.3.6.1.2.1.1.1.0"
                  />
                  <SelectField
                    control={control}
                    name="snmpVersion"
                    label="Version"
                    options={SNMP_VERSIONS.map((v) => ({ value: v, label: `SNMPv${v}` }))}
                  />
                  <TextField
                    control={control}
                    name="snmpCommunity"
                    label="Community string"
                    placeholder="public"
                  />
                </div>
              )}

              {type === 'smtp' && (
                <SelectField
                  control={control}
                  name="smtpSecurity"
                  label="Security"
                  options={SMTP_SECURITY_MODES.map((m) => ({
                    value: m,
                    label: SMTP_SECURITY_LABELS[m],
                  }))}
                  description="Use SMTPS for port 465; STARTTLS for 25/587."
                />
              )}

              {type === 'sftp' && (
                <>
                  <div className="grid gap-5 sm:grid-cols-2">
                    <TextField
                      control={control}
                      name="sshUsername"
                      label="Username"
                      autoComplete="off"
                    />
                    <SelectField
                      control={control}
                      name="sshAuthMethod"
                      label="Authentication"
                      options={SSH_AUTH_METHODS.map((m) => ({
                        value: m,
                        label: m === 'privateKey' ? 'Private key' : 'Password',
                      }))}
                    />
                  </div>
                  {sshAuthMethod === 'privateKey' ? (
                    <>
                      <TextareaField
                        control={control}
                        name="sshPrivateKey"
                        label="Private key (PEM)"
                        mono
                        rows={5}
                      />
                      <TextField
                        control={control}
                        name="sshPassphrase"
                        label="Passphrase"
                        type="password"
                        autoComplete="off"
                        description="Only when the key is encrypted."
                      />
                    </>
                  ) : (
                    <TextField
                      control={control}
                      name="sshPassword"
                      label="Password"
                      type="password"
                      autoComplete="new-password"
                    />
                  )}
                  <TextField
                    control={control}
                    name="sftpPath"
                    label="Remote path"
                    placeholder="/var/backups"
                    description="Optional path that must exist on the server."
                  />
                </>
              )}

              {type === 'rabbitmq' && (
                <>
                  <ListField
                    control={control}
                    name="rabbitmqNodes"
                    label="Nodes"
                    placeholder={
                      'https://node1.rabbitmq.example:15672\nhttps://node2.rabbitmq.example:15672'
                    }
                    description="Management API base URLs, one per line. UP when any node reports no alarms."
                  />
                  <div className="grid gap-5 sm:grid-cols-2">
                    <TextField
                      control={control}
                      name="rabbitmqUsername"
                      label="Username"
                      autoComplete="off"
                    />
                    <TextField
                      control={control}
                      name="rabbitmqPassword"
                      label="Password"
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
                    label="Accepted close codes"
                    description={
                      <>
                        Close codes counted as UP, e.g. <code>1000</code>.
                      </>
                    }
                  />
                  <TextareaField
                    control={control}
                    name="headers"
                    label="Headers"
                    mono
                    placeholder={'{\n  "Origin": "https://example.com"\n}'}
                    description="JSON object of extra handshake headers."
                  />
                  <TextField
                    control={control}
                    name="wsSubprotocol"
                    label="Subprotocols"
                    placeholder="graphql-ws, mqtt"
                    description="Comma-separated Sec-WebSocket-Protocol values (optional)."
                  />
                  <div className="grid gap-3 sm:grid-cols-2">
                    <SwitchField
                      control={control}
                      name="wsIgnoreSecWebsocketAcceptHeader"
                      label="Ignore Sec-WebSocket-Accept"
                      description="Accept servers that answer without the header."
                    />
                    <SwitchField
                      control={control}
                      name="ignoreTls"
                      label="Ignore TLS errors"
                      description="Accept self-signed or expired certificates."
                    />
                  </div>
                </>
              )}

              {type === 'gamedig' && (
                <>
                  <TextField
                    control={control}
                    name="game"
                    label="Game"
                    placeholder="minecraft"
                    description={
                      <>
                        GameDig game id, see{' '}
                        <a
                          className="underline"
                          href="https://github.com/gamedig/node-gamedig/blob/master/GAMES_LIST.md"
                          target="_blank"
                          rel="noreferrer"
                        >
                          the games list
                        </a>
                        .
                      </>
                    }
                  />
                  <SwitchField
                    control={control}
                    name="gamedigGivenPortOnly"
                    label="Given port only"
                    description="Do not probe the other ports the game commonly uses."
                  />
                </>
              )}

              {type === 'steam' && (
                <p className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground">
                  The server is looked up through the Steam Web API. A superadmin must set the Steam
                  API key in the instance settings first.
                </p>
              )}

              {type === 'real-browser' && (
                <>
                  <TextField
                    control={control}
                    name="remoteBrowser"
                    label="Remote browser URL"
                    placeholder="ws://browserless:3000"
                    description="Playwright-compatible browser server (e.g. browserless or `npx playwright run-server`). Marmot does not launch Chromium itself."
                  />
                  <SwitchField
                    control={control}
                    name="ignoreTls"
                    label="Ignore TLS errors"
                    description="Accept self-signed or expired certificates."
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
              <CardTitle>HTTP options</CardTitle>
              <CardDescription>
                Request shape and what counts as a healthy response.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-5">
              <div className="grid gap-5 sm:grid-cols-3">
                <SelectField
                  control={control}
                  name="method"
                  label="Method"
                  options={HTTP_METHODS.map((m) => ({ value: m, label: m }))}
                />
                <SelectField
                  control={control}
                  name="httpBodyEncoding"
                  label="Body encoding"
                  options={BODY_ENCODINGS.map((e) => ({ value: e, label: ENCODING_LABELS[e] }))}
                />
                <NumberField control={control} name="maxRedirects" label="Max. redirects" min={0} />
              </div>
              <TextareaField
                control={control}
                name="body"
                label="Body"
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
                label="Headers"
                mono
                placeholder={'{\n  "Authorization": "Token abc"\n}'}
                description="JSON object of extra request headers."
              />
              <StatusCodesField control={control} />
              <div className="grid gap-3 sm:grid-cols-2">
                <SwitchField
                  control={control}
                  name="ignoreTls"
                  label="Ignore TLS errors"
                  description="Accept self-signed or expired certificates."
                />
                <SwitchField
                  control={control}
                  name="expiryNotification"
                  label="Certificate expiry notification"
                  description="Warn before the TLS certificate expires."
                />
              </div>
            </CardContent>
          </Card>
        )}

        {/* Authentication ------------------------------------------------------------------ */}
        {(isHttp || isWebSocket) && (
          <Card>
            <CardHeader>
              <CardTitle>Authentication</CardTitle>
              <CardDescription>Credentials sent with every check.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-5">
              <SelectField
                control={control}
                name="authMethod"
                label="Method"
                options={(isWebSocket ? WS_AUTH_METHODS : AUTH_METHODS).map((m) => ({
                  value: m,
                  label: AUTH_LABELS[m],
                }))}
              />
              {(authMethod === 'basic' || authMethod === 'ntlm') && (
                <div className="grid gap-5 sm:grid-cols-2">
                  <TextField
                    control={control}
                    name="basicAuthUser"
                    label="Username"
                    autoComplete="off"
                  />
                  <TextField
                    control={control}
                    name="basicAuthPass"
                    label="Password"
                    type="password"
                    autoComplete="new-password"
                  />
                </div>
              )}
              {authMethod === 'ntlm' && (
                <div className="grid gap-5 sm:grid-cols-2">
                  <TextField control={control} name="authDomain" label="Domain" />
                  <TextField control={control} name="authWorkstation" label="Workstation" />
                </div>
              )}
              {authMethod === 'bearer' && (
                <TextField
                  control={control}
                  name="bearerToken"
                  label="Token"
                  type="password"
                  autoComplete="off"
                  description="Sent as Authorization: Bearer <token>."
                />
              )}
              {authMethod === 'oauth2-cc' && (
                <>
                  <TextField
                    control={control}
                    name="oauthTokenUrl"
                    label="Token URL"
                    type="url"
                    placeholder="https://auth.example.com/oauth/token"
                  />
                  <div className="grid gap-5 sm:grid-cols-2">
                    <TextField control={control} name="oauthClientId" label="Client ID" />
                    <TextField
                      control={control}
                      name="oauthClientSecret"
                      label="Client secret"
                      type="password"
                      autoComplete="off"
                    />
                  </div>
                  <div className="grid gap-5 sm:grid-cols-2">
                    <TextField
                      control={control}
                      name="oauthScopes"
                      label="Scopes"
                      placeholder="read write"
                    />
                    <SelectField
                      control={control}
                      name="oauthAuthMethod"
                      label="Client authentication"
                      options={[
                        { value: 'client_secret_basic', label: 'HTTP Basic (client_secret_basic)' },
                        { value: 'client_secret_post', label: 'Request body (client_secret_post)' },
                      ]}
                    />
                  </div>
                </>
              )}
              {authMethod === 'mtls' && (
                <>
                  <TextareaField
                    control={control}
                    name="tlsCert"
                    label="Client certificate (PEM)"
                    mono
                    rows={5}
                  />
                  <TextareaField
                    control={control}
                    name="tlsKey"
                    label="Private key (PEM)"
                    mono
                    rows={5}
                  />
                  <TextareaField
                    control={control}
                    name="tlsCa"
                    label="CA certificate (PEM, optional)"
                    mono
                    rows={5}
                  />
                </>
              )}
            </CardContent>
          </Card>
        )}

        {/* Advanced ------------------------------------------------------------------------ */}
        {type !== 'group' && (
          <Card>
            <CardHeader>
              <CardTitle>Advanced</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-3">
              <SwitchField
                control={control}
                name="upsideDown"
                label="Upside down mode"
                description="Flip the status: a failed check counts as UP and a successful one as DOWN."
              />
              <SwitchField
                control={control}
                name="active"
                label="Active"
                description="Paused monitors keep their history but are not checked."
              />
            </CardContent>
          </Card>
        )}

        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" asChild disabled={pending}>
            <Link
              href={
                mode === 'edit' && monitorId
                  ? `/${orgSlug}/monitors/${monitorId}`
                  : `/${orgSlug}/monitors`
              }
            >
              Cancel
            </Link>
          </Button>
          <Button type="submit" disabled={pending} data-testid="monitor-submit">
            {pending && <Loader2 className="animate-spin" />}
            {mode === 'create' ? 'Create monitor' : 'Save changes'}
          </Button>
        </div>
      </form>
    </Form>
  )
}
