'use client'

import { ExternalLink, Loader2, Send } from 'lucide-react'
import { useTranslations } from 'next-intl'
import * as React from 'react'
import { useForm, useWatch, type Path } from 'react-hook-form'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
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
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { Switch } from '@/components/ui/switch'
import { track } from '@/lib/analytics'
import { ApiError } from '@/lib/api'
import {
  CHANNEL_EVENTS,
  DEFAULT_CHANNEL_EVENTS,
  type ChannelEvent,
} from '@/lib/notification-events'

import { ProviderField } from './provider-field'
import {
  notificationsApi,
  PROVIDER_GROUP_ORDER,
  type NotificationInput,
  type NotificationProviderDescriptor,
  type NotificationRow,
  type TestResult,
} from './types'

interface FormValues {
  name: string
  type: string
  isDefault: boolean
  applyExisting: boolean
  active: boolean
  config: Record<string, unknown>
  events: ChannelEvent[]
}

interface ChannelDialogProps {
  orgId: string
  providers: NotificationProviderDescriptor[]
  /** Why this user may not turn on the server SMTP settings, or `null` when they may. */
  serverSmtpRestriction: string | null
  /** Row being edited, or `null` for a new channel. */
  channel: NotificationRow | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onSaved: (row: NotificationRow) => void
}

/** Default config for a provider: schema defaults, blanks for everything else. */
function defaultConfig(provider: NotificationProviderDescriptor | undefined) {
  const config: Record<string, unknown> = {}
  for (const field of provider?.fields ?? []) {
    if (field.defaultValue !== undefined) config[field.name] = field.defaultValue
    else if (field.kind === 'boolean') config[field.name] = false
  }
  return config
}

/** Drop empty optional values so the server applies schema defaults. */
function cleanConfig(
  provider: NotificationProviderDescriptor | undefined,
  config: Record<string, unknown>,
) {
  const out: Record<string, unknown> = {}
  for (const field of provider?.fields ?? []) {
    const value = config[field.name]
    if (value === undefined || value === null || value === '') continue
    out[field.name] = value
  }
  return out
}

/** `config.webhookUrl: Invalid URL` → `['config.webhookUrl', 'Invalid URL']`. */
function splitFieldError(message: string): [string | null, string] {
  const match = /^((?:config\.)?[A-Za-z0-9_]+):\s*(.+)$/s.exec(message)
  return match ? [match[1], match[2]] : [null, message]
}

export function ChannelDialog({
  orgId,
  providers,
  serverSmtpRestriction,
  channel,
  open,
  onOpenChange,
  onSaved,
}: ChannelDialogProps) {
  const t = useTranslations('notifications')
  const [saving, setSaving] = React.useState(false)
  const [testing, setTesting] = React.useState(false)

  const form = useForm<FormValues>({
    defaultValues: {
      name: '',
      type: providers[0]?.name ?? '',
      isDefault: false,
      applyExisting: false,
      active: true,
      config: defaultConfig(providers[0]),
      events: [...DEFAULT_CHANNEL_EVENTS],
    },
  })

  const type = useWatch({ control: form.control, name: 'type' })
  const useServerSmtp = useWatch({ control: form.control, name: 'config.useServerSmtp' }) === true
  const isDefault = useWatch({ control: form.control, name: 'isDefault' })
  const applyExisting = useWatch({ control: form.control, name: 'applyExisting' })
  const active = useWatch({ control: form.control, name: 'active' })
  const events = useWatch({ control: form.control, name: 'events' })
  const provider = React.useMemo(() => providers.find((p) => p.name === type), [providers, type])

  // Reset the form whenever the dialog opens for a different channel.
  React.useEffect(() => {
    if (!open) return
    const initialProvider = channel ? providers.find((p) => p.name === channel.type) : providers[0]
    form.reset({
      name: channel?.name ?? '',
      type: channel?.type ?? initialProvider?.name ?? '',
      isDefault: channel?.isDefault ?? false,
      applyExisting: false,
      active: channel?.active ?? true,
      config: { ...defaultConfig(initialProvider), ...(channel?.config ?? {}) },
      events: channel?.events ?? [...DEFAULT_CHANNEL_EVENTS],
    })
  }, [open, channel, providers, form])

  // The selection is never empty (an empty one would silently mean the defaults on the server).
  React.useEffect(() => {
    form.register('events', {
      validate: (value) => value.length > 0 || t('dialog.eventsRequired'),
    })
  }, [form, t])

  function toggleEvent(event: ChannelEvent, checked: boolean) {
    const current = form.getValues('events')
    const next = checked ? [...current, event] : current.filter((e) => e !== event)
    form.setValue(
      'events',
      CHANNEL_EVENTS.filter((e) => next.includes(e)),
      { shouldDirty: true, shouldValidate: true },
    )
  }

  function changeProvider(next: string) {
    const nextProvider = providers.find((p) => p.name === next)
    form.setValue('type', next, { shouldDirty: true })
    form.setValue('config', defaultConfig(nextProvider))
    form.clearErrors()
  }

  function applyServerError(error: unknown) {
    const message = error instanceof Error ? error.message : t('dialog.failed')
    const [path, text] = splitFieldError(message)
    const known = path && (path === 'name' || path === 'type' || path.startsWith('config.'))
    if (known) form.setError(path as Path<FormValues>, { message: text })
    else form.setError('root', { message })
  }

  async function onSubmit(values: FormValues) {
    setSaving(true)
    form.clearErrors('root')
    const input: NotificationInput = {
      name: values.name.trim(),
      type: values.type,
      config: cleanConfig(provider, values.config),
      events: values.events,
      isDefault: values.isDefault,
      applyExisting: values.applyExisting,
      active: values.active,
    }
    try {
      const saved = channel
        ? await notificationsApi.update(orgId, channel.id, input)
        : await notificationsApi.create(orgId, input)
      if (!channel) track('notification_channel_created', { provider: input.type })
      toast.success(channel ? t('dialog.updated') : t('dialog.created'))
      onSaved(saved)
      onOpenChange(false)
    } catch (error) {
      applyServerError(error)
    } finally {
      setSaving(false)
    }
  }

  async function onTest() {
    const valid = await form.trigger()
    if (!valid) return
    const values = form.getValues()
    setTesting(true)
    form.clearErrors('root')
    try {
      const result = await notificationsApi.test(orgId, {
        ...(channel ? { notificationId: channel.id } : { type: values.type }),
        config: cleanConfig(provider, values.config),
        name: values.name.trim() || undefined,
        events: values.events,
      })
      toast.success(t('test.sent'), { description: describeTest(result) })
    } catch (error) {
      const details = error instanceof ApiError ? (error.details as { error?: string }) : null
      const message = details?.error ?? (error instanceof Error ? error.message : t('test.failed'))
      toast.error(t('test.failed'), { description: message })
      form.setError('root', { message })
    } finally {
      setTesting(false)
    }
  }

  function describeTest(result: TestResult) {
    const sent = result.events ?? []
    if (sent.length === 0) return result.result
    return t('test.sentSamples', {
      count: sent.length,
      events: sent.map((event) => t(`events.${event}.label`)).join(', '),
    })
  }

  const rootError = form.formState.errors.root?.message
  const eventsError = form.formState.errors.events?.message
  const nameError = form.formState.errors.name?.message
  const grouped = PROVIDER_GROUP_ORDER.map((group) => ({
    group,
    items: providers.filter((p) => p.group === group),
  })).filter((g) => g.items.length > 0)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{channel ? t('dialog.editTitle') : t('dialog.newTitle')}</DialogTitle>
          <DialogDescription>
            {channel ? t('dialog.editDescription') : t('dialog.newDescription')}
          </DialogDescription>
        </DialogHeader>

        <form
          id="channel-form"
          onSubmit={form.handleSubmit(onSubmit)}
          className="flex flex-col gap-5"
          noValidate
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="channel-type">{t('dialog.provider')}</Label>
              <Select value={type} onValueChange={changeProvider} disabled={Boolean(channel)}>
                <SelectTrigger id="channel-type" className="w-full">
                  <SelectValue placeholder={t('dialog.providerPlaceholder')} />
                </SelectTrigger>
                <SelectContent>
                  {grouped.map(({ group, items }) => (
                    <SelectGroup key={group}>
                      <SelectLabel>{t(`groups.${group}`)}</SelectLabel>
                      {items.map((p) => (
                        <SelectItem key={p.name} value={p.name}>
                          {p.label}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  ))}
                </SelectContent>
              </Select>
              {provider?.docsUrl && (
                <a
                  href={provider.docsUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-xs text-muted-foreground underline-offset-4 hover:underline"
                >
                  {t('dialog.setupGuide')} <ExternalLink className="size-3" aria-hidden />
                </a>
              )}
            </div>
            <div className="grid gap-2">
              <Label htmlFor="channel-name" className={nameError ? 'text-destructive' : undefined}>
                {t('dialog.name')}
              </Label>
              <Input
                id="channel-name"
                placeholder={
                  provider
                    ? t('dialog.namePlaceholder', { provider: provider.label })
                    : t('dialog.namePlaceholderGeneric')
                }
                aria-invalid={!!nameError}
                {...form.register('name', { required: t('dialog.nameRequired') })}
              />
              {nameError && (
                <p role="alert" className="text-sm text-destructive">
                  {nameError}
                </p>
              )}
            </div>
          </div>

          <Separator />

          {provider ? (
            <div className="grid gap-4">
              {provider.fields.map((field) => {
                // The server refuses this option for users who may not use it; an existing channel
                // that already uses it can still switch it off.
                const restricted =
                  provider.name === 'smtp' &&
                  field.name === 'useServerSmtp' &&
                  serverSmtpRestriction !== null
                return (
                  <ProviderField
                    key={`${provider.name}.${field.name}`}
                    control={form.control}
                    name={`config.${field.name}` as Path<FormValues>}
                    field={field}
                    disabled={restricted && !useServerSmtp}
                    note={restricted ? serverSmtpRestriction : undefined}
                  />
                )
              })}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">{t('dialog.noProviders')}</p>
          )}

          <Separator />

          <div
            role="group"
            aria-labelledby="channel-events-label"
            aria-describedby="channel-events-hint"
            className="grid gap-3"
          >
            <div className="space-y-0.5">
              <p id="channel-events-label" className="text-sm leading-none font-medium">
                {t('dialog.events')}
              </p>
              <p id="channel-events-hint" className="text-xs text-muted-foreground">
                {t('dialog.eventsHint')}
              </p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              {CHANNEL_EVENTS.map((event) => (
                <ToggleRow
                  key={event}
                  id={`channel-event-${event}`}
                  label={t(`events.${event}.label`)}
                  description={t(`events.${event}.description`)}
                  checked={events.includes(event)}
                  onCheckedChange={(v) => toggleEvent(event, v)}
                />
              ))}
            </div>
            {eventsError && (
              <p role="alert" className="text-sm text-destructive">
                {eventsError}
              </p>
            )}
          </div>

          <Separator />

          <div className="grid gap-3">
            <ToggleRow
              id="channel-default"
              label={t('dialog.isDefault')}
              description={t('dialog.isDefaultHint')}
              checked={isDefault}
              onCheckedChange={(v) => form.setValue('isDefault', v, { shouldDirty: true })}
            />
            <ToggleRow
              id="channel-apply-existing"
              label={t('dialog.applyExisting')}
              description={t('dialog.applyExistingHint')}
              checked={applyExisting}
              onCheckedChange={(v) => form.setValue('applyExisting', v, { shouldDirty: true })}
            />
            <ToggleRow
              id="channel-active"
              label={t('dialog.active')}
              description={t('dialog.activeHint')}
              checked={active}
              onCheckedChange={(v) => form.setValue('active', v, { shouldDirty: true })}
            />
          </div>

          {rootError && (
            <p
              role="alert"
              className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
            >
              {rootError}
            </p>
          )}
        </form>

        <DialogFooter className="sm:justify-between">
          <Button
            type="button"
            variant="outline"
            onClick={onTest}
            disabled={testing || saving || !provider}
          >
            {testing ? <Loader2 className="animate-spin" /> : <Send />}
            {t('dialog.sendTest')}
          </Button>
          <div className="flex gap-2">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              {t('dialog.cancel')}
            </Button>
            <Button type="submit" form="channel-form" disabled={saving || testing || !provider}>
              {saving && <Loader2 className="animate-spin" />}
              {channel ? t('dialog.save') : t('dialog.create')}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ToggleRow({
  id,
  label,
  description,
  checked,
  onCheckedChange,
}: {
  id: string
  label: string
  description: string
  checked: boolean
  onCheckedChange: (checked: boolean) => void
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="space-y-0.5">
        <Label htmlFor={id}>{label}</Label>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onCheckedChange} />
    </div>
  )
}
