'use client'

import { Eye, EyeOff, Loader2 } from 'lucide-react'
import { useTranslations } from 'next-intl'
import * as React from 'react'

import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ApiError } from '@/lib/api'
import { CHANNEL_EVENTS, type ChannelEvent } from '@/lib/notification-events'
import { templateVariableNames } from '@/lib/notification-template-variables'

import {
  notificationsApi,
  type NotificationPreview,
  type NotificationProviderDescriptor,
} from './types'

interface TemplatePreviewProps {
  orgId: string
  provider: NotificationProviderDescriptor
  /** The form's current (unsaved) config. */
  config: Record<string, unknown>
  /** First sample shown: the first event the channel listens to. */
  initialEvent: ChannelEvent
}

const VARIABLES = templateVariableNames()

/** Does the provider have message templates (and so a preview)? */
export const hasTemplates = (provider: NotificationProviderDescriptor | undefined) =>
  Boolean(provider?.fields.some((field) => field.template))

const pre =
  'max-h-48 overflow-auto rounded-md border bg-muted/40 px-3 py-2 text-xs whitespace-pre-wrap break-words'

/**
 * Channel form panel that renders the default message and the channel's templates for a sample of
 * one event (#150), and for email providers the email itself (HTML in a sandboxed frame, plus the
 * plain-text part). Re-renders as the settings change; nothing is sent.
 */
export function TemplatePreview({ orgId, provider, config, initialEvent }: TemplatePreviewProps) {
  const t = useTranslations('notifications')
  const [open, setOpen] = React.useState(false)
  const [event, setEvent] = React.useState<ChannelEvent>(initialEvent)
  const [preview, setPreview] = React.useState<NotificationPreview | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const configKey = JSON.stringify(config)

  React.useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    // Debounced: typing in a template field re-renders after a short pause.
    const timer = setTimeout(async () => {
      setLoading(true)
      try {
        const result = await notificationsApi.preview(
          orgId,
          { type: provider.name, config: JSON.parse(configKey), event },
          { signal: controller.signal },
        )
        setPreview(result)
        setError(null)
      } catch (err) {
        if (controller.signal.aborted) return
        const details = err instanceof ApiError ? (err.details as { error?: string }) : null
        setError(details?.error ?? t('preview.failed'))
      } finally {
        if (!controller.signal.aborted) setLoading(false)
      }
    }, 400)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [open, orgId, provider.name, configKey, event, t])

  const labelOf = (name: string) => provider.fields.find((f) => f.name === name)?.label ?? name

  return (
    <section aria-labelledby="channel-preview-label" className="grid gap-3">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-0.5">
          <p id="channel-preview-label" className="text-sm leading-none font-medium">
            {t('preview.title')}
          </p>
          <p className="text-xs text-muted-foreground">{t('preview.description')}</p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-expanded={open}
          aria-controls="channel-preview-body"
          onClick={() => setOpen((value) => !value)}
        >
          {open ? <EyeOff /> : <Eye />}
          {open ? t('preview.hide') : t('preview.show')}
        </Button>
      </div>

      {open && (
        <div id="channel-preview-body" className="grid gap-3">
          <div className="flex items-end gap-2">
            <div className="grid flex-1 gap-2">
              <Label htmlFor="channel-preview-event">{t('preview.event')}</Label>
              <Select value={event} onValueChange={(value) => setEvent(value as ChannelEvent)}>
                <SelectTrigger id="channel-preview-event" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CHANNEL_EVENTS.map((e) => (
                    <SelectItem key={e} value={e}>
                      {t(`events.${e}.label`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <span className="flex size-9 items-center justify-center" aria-live="polite">
              {loading && (
                <Loader2
                  className="size-4 animate-spin text-muted-foreground"
                  aria-label={t('preview.rendering')}
                />
              )}
            </span>
          </div>

          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}

          {preview && (
            <div className="grid gap-3" data-testid="channel-preview">
              <div className="grid gap-1">
                <p className="text-xs font-medium text-muted-foreground">
                  {t('preview.defaultMessage')}
                </p>
                <pre className={pre}>{preview.message}</pre>
              </div>

              {preview.fields.map((field) => (
                <div key={field.name} className="grid gap-1">
                  <p className="text-xs font-medium text-muted-foreground">{labelOf(field.name)}</p>
                  {field.error ? (
                    <p role="alert" className="text-sm text-destructive">
                      {field.error} {t('preview.fallback')}
                    </p>
                  ) : (
                    <pre className={pre}>{field.output}</pre>
                  )}
                </div>
              ))}

              {preview.email && (
                <div className="grid gap-2">
                  <p className="text-sm">
                    <span className="text-muted-foreground">{t('preview.subject')}</span>{' '}
                    <span className="font-medium">{preview.email.subject}</span>
                  </p>
                  {preview.email.html !== null ? (
                    <Tabs defaultValue="html">
                      <TabsList>
                        <TabsTrigger value="html">{t('preview.html')}</TabsTrigger>
                        <TabsTrigger value="text">{t('preview.text')}</TabsTrigger>
                      </TabsList>
                      <TabsContent value="html">
                        {/* No scripts, forms or same-origin access: the HTML is user-authored. */}
                        <iframe
                          title={t('preview.emailFrame')}
                          sandbox=""
                          srcDoc={preview.email.html}
                          className="h-96 w-full rounded-md border bg-white"
                        />
                      </TabsContent>
                      <TabsContent value="text">
                        <pre className={pre}>{preview.email.text}</pre>
                      </TabsContent>
                    </Tabs>
                  ) : (
                    <pre className={pre}>{preview.email.text}</pre>
                  )}
                </div>
              )}
            </div>
          )}

          <details className="text-xs">
            <summary className="cursor-pointer font-medium">{t('preview.variables')}</summary>
            <p className="mt-2 text-muted-foreground">{t('preview.variablesHint')}</p>
            <ul className="mt-2 flex flex-wrap gap-1">
              {VARIABLES.map((name) => (
                <li key={name}>
                  <code className="rounded bg-muted px-1.5 py-0.5">{`{{ ${name} }}`}</code>
                </li>
              ))}
            </ul>
          </details>
        </div>
      )}
    </section>
  )
}
