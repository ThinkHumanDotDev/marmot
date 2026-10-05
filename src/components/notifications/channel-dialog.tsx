'use client'

import { ExternalLink, Loader2, Send } from 'lucide-react'
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
import { ApiError } from '@/lib/api'

import { ProviderField } from './provider-field'
import {
  notificationsApi,
  PROVIDER_GROUP_LABELS,
  PROVIDER_GROUP_ORDER,
  type NotificationInput,
  type NotificationProviderDescriptor,
  type NotificationRow,
} from './types'

interface FormValues {
  name: string
  type: string
  isDefault: boolean
  applyExisting: boolean
  active: boolean
  config: Record<string, unknown>
}

interface ChannelDialogProps {
  orgId: string
  providers: NotificationProviderDescriptor[]
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
  channel,
  open,
  onOpenChange,
  onSaved,
}: ChannelDialogProps) {
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
    },
  })

  const type = useWatch({ control: form.control, name: 'type' })
  const isDefault = useWatch({ control: form.control, name: 'isDefault' })
  const applyExisting = useWatch({ control: form.control, name: 'applyExisting' })
  const active = useWatch({ control: form.control, name: 'active' })
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
    })
  }, [open, channel, providers, form])

  function changeProvider(next: string) {
    const nextProvider = providers.find((p) => p.name === next)
    form.setValue('type', next, { shouldDirty: true })
    form.setValue('config', defaultConfig(nextProvider))
    form.clearErrors()
  }

  function applyServerError(error: unknown) {
    const message = error instanceof Error ? error.message : 'Something went wrong.'
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
      isDefault: values.isDefault,
      applyExisting: values.applyExisting,
      active: values.active,
    }
    try {
      const saved = channel
        ? await notificationsApi.update(orgId, channel.id, input)
        : await notificationsApi.create(orgId, input)
      toast.success(channel ? 'Channel updated' : 'Channel created')
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
        type: values.type,
        config: cleanConfig(provider, values.config),
        name: values.name.trim() || undefined,
      })
      toast.success('Test message sent', { description: result.result })
    } catch (error) {
      const details = error instanceof ApiError ? (error.details as { error?: string }) : null
      const message = details?.error ?? (error instanceof Error ? error.message : 'Test failed')
      toast.error('Test failed', { description: message })
      form.setError('root', { message })
    } finally {
      setTesting(false)
    }
  }

  const rootError = form.formState.errors.root?.message
  const nameError = form.formState.errors.name?.message
  const grouped = PROVIDER_GROUP_ORDER.map((group) => ({
    group,
    items: providers.filter((p) => p.group === group),
  })).filter((g) => g.items.length > 0)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{channel ? 'Edit channel' : 'New notification channel'}</DialogTitle>
          <DialogDescription>
            {channel
              ? 'Change where this channel delivers alerts.'
              : 'Pick a provider, fill in its settings and send yourself a test message.'}
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
              <Label htmlFor="channel-type">Provider</Label>
              <Select value={type} onValueChange={changeProvider} disabled={Boolean(channel)}>
                <SelectTrigger id="channel-type" className="w-full">
                  <SelectValue placeholder="Choose a provider" />
                </SelectTrigger>
                <SelectContent>
                  {grouped.map(({ group, items }) => (
                    <SelectGroup key={group}>
                      <SelectLabel>{PROVIDER_GROUP_LABELS[group]}</SelectLabel>
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
                  Setup guide <ExternalLink className="size-3" aria-hidden />
                </a>
              )}
            </div>
            <div className="grid gap-2">
              <Label htmlFor="channel-name" className={nameError ? 'text-destructive' : undefined}>
                Friendly name
              </Label>
              <Input
                id="channel-name"
                placeholder={provider ? `${provider.label} alerts` : 'Alerts'}
                aria-invalid={!!nameError}
                {...form.register('name', { required: 'Give the channel a name' })}
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
              {provider.fields.map((field) => (
                <ProviderField
                  key={`${provider.name}.${field.name}`}
                  control={form.control}
                  name={`config.${field.name}` as Path<FormValues>}
                  field={field}
                />
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No providers are registered.</p>
          )}

          <Separator />

          <div className="grid gap-3">
            <ToggleRow
              id="channel-default"
              label="Default channel"
              description="Attach to every monitor created from now on."
              checked={isDefault}
              onCheckedChange={(v) => form.setValue('isDefault', v, { shouldDirty: true })}
            />
            <ToggleRow
              id="channel-apply-existing"
              label="Apply to all existing monitors"
              description="On save, attach this channel to every monitor in the organization."
              checked={applyExisting}
              onCheckedChange={(v) => form.setValue('applyExisting', v, { shouldDirty: true })}
            />
            <ToggleRow
              id="channel-active"
              label="Active"
              description="Inactive channels stay attached but are never sent to."
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
            Send test
          </Button>
          <div className="flex gap-2">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" form="channel-form" disabled={saving || testing || !provider}>
              {saving && <Loader2 className="animate-spin" />}
              {channel ? 'Save changes' : 'Create channel'}
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
