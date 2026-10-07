'use client'

import { BellRing } from 'lucide-react'
import { useTranslations } from 'next-intl'
import * as React from 'react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { SMS_CODE_LENGTH, type SubscriberChannel } from '@/lib/status-page-subscribers'
import { cn } from '@/lib/utils'
import type { PublicGroup } from '@/server/status-pages/public'

import { ComponentPicker, pickerGroups } from './component-picker'

type Step =
  | { kind: 'form' }
  | { kind: 'code'; target: string }
  | { kind: 'message'; text: string; manageUrl?: string }

const INPUT_TYPES: Record<SubscriberChannel, string> = {
  email: 'email',
  sms: 'tel',
  webhook: 'url',
  slack: 'url',
}

/** "Subscribe" button and dialog of the public page (#104). */
export function SubscribeDialog({
  slug,
  title,
  channels,
  groups,
}: {
  slug: string
  title: string
  channels: SubscriberChannel[]
  groups: PublicGroup[]
}) {
  const t = useTranslations('statusPages.subscribe')
  const [open, setOpen] = React.useState(false)
  const [channel, setChannel] = React.useState<SubscriberChannel>(channels[0] ?? 'email')
  const [target, setTarget] = React.useState('')
  const [scoped, setScoped] = React.useState(false)
  const [components, setComponents] = React.useState<string[]>([])
  const [code, setCode] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [step, setStep] = React.useState<Step>({ kind: 'form' })
  const options = React.useMemo(() => pickerGroups(groups), [groups])
  const base = `/api/status-pages/${encodeURIComponent(slug)}`

  function reset(next: boolean) {
    setOpen(next)
    if (!next) {
      setStep({ kind: 'form' })
      setError(null)
      setCode('')
    }
  }

  async function post(path: string, body: unknown) {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body),
    })
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (!res.ok) throw new Error(typeof json.error === 'string' ? json.error : t('failed'))
    return json
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const json = await post('/subscribe', {
        channel,
        target,
        components: scoped ? components : [],
      })
      if (json.next === 'enter-code') setStep({ kind: 'code', target })
      else if (json.next === 'confirm-email') setStep({ kind: 'message', text: t('checkEmail') })
      else setStep({ kind: 'message', text: t('done') })
    } catch (err) {
      setError(err instanceof Error ? err.message : t('failed'))
    } finally {
      setBusy(false)
    }
  }

  async function verify(event: React.FormEvent) {
    event.preventDefault()
    if (step.kind !== 'code') return
    setBusy(true)
    setError(null)
    try {
      const json = await post('/subscribe/verify', { target: step.target, code })
      setStep({
        kind: 'message',
        text: t('verified'),
        manageUrl: typeof json.manageUrl === 'string' ? json.manageUrl : undefined,
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : t('failed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={reset}>
      <DialogTrigger asChild>
        <button
          type="button"
          data-subscribe-button
          className="inline-flex shrink-0 items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-accent"
        >
          <BellRing className="size-4" aria-hidden />
          {t('button')}
        </button>
      </DialogTrigger>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{t('description', { title })}</DialogDescription>
        </DialogHeader>

        {error && (
          <p
            role="alert"
            className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            {error}
          </p>
        )}

        {step.kind === 'form' && (
          <form onSubmit={submit} className="flex flex-col gap-4">
            {channels.length > 1 && (
              <fieldset className="flex flex-col gap-2">
                <legend className="mb-2 text-sm font-medium">{t('channel')}</legend>
                <div className="flex flex-wrap gap-2">
                  {channels.map((value) => (
                    <label
                      key={value}
                      className={cn(
                        'cursor-pointer rounded-md border px-3 py-1.5 text-sm',
                        channel === value
                          ? 'border-primary bg-primary/5 font-medium'
                          : 'hover:bg-muted/50',
                      )}
                    >
                      <input
                        type="radio"
                        name="channel"
                        value={value}
                        checked={channel === value}
                        onChange={() => setChannel(value)}
                        className="sr-only"
                      />
                      {t(`channels.${value}`)}
                    </label>
                  ))}
                </div>
              </fieldset>
            )}
            <div className="grid gap-2">
              <Label htmlFor="subscribe-target">{t(`target.${channel}`)}</Label>
              <Input
                id="subscribe-target"
                type={INPUT_TYPES[channel]}
                autoComplete={channel === 'email' ? 'email' : channel === 'sms' ? 'tel' : 'off'}
                placeholder={t(`placeholder.${channel}`)}
                value={target}
                required
                onChange={(e) => setTarget(e.target.value)}
              />
              {channel === 'sms' && <p className="text-xs text-muted-foreground">{t('smsHint')}</p>}
              {channel === 'webhook' && (
                <p className="text-xs text-muted-foreground">{t('webhookHint')}</p>
              )}
            </div>
            {options.length > 0 && (
              <ComponentPicker
                legend={t('components')}
                allLabel={t('allComponents')}
                someLabel={t('someComponents')}
                groups={options}
                scoped={scoped}
                selected={components}
                onScopedChange={setScoped}
                onSelectedChange={setComponents}
              />
            )}
            <Button type="submit" disabled={busy || (scoped && components.length === 0)}>
              {busy ? t('submitting') : t('submit')}
            </Button>
          </form>
        )}

        {step.kind === 'code' && (
          <form onSubmit={verify} className="flex flex-col gap-3">
            <Label htmlFor="subscribe-code">{t('code')}</Label>
            <Input
              id="subscribe-code"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]*"
              maxLength={SMS_CODE_LENGTH}
              value={code}
              required
              autoFocus
              onChange={(e) => setCode(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              {t('codeHint', { length: SMS_CODE_LENGTH, target: step.target })}
            </p>
            <Button type="submit" disabled={busy}>
              {busy ? t('verifying') : t('verify')}
            </Button>
          </form>
        )}

        {step.kind === 'message' && (
          <div className="flex flex-col gap-3" role="status">
            <p className="text-sm">{step.text}</p>
            {step.manageUrl && (
              <a href={step.manageUrl} className="text-sm underline underline-offset-4">
                {t('manageLink')}
              </a>
            )}
            <Button type="button" variant="outline" onClick={() => reset(false)}>
              {t('close')}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
