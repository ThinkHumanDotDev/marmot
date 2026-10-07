'use client'

import { Download, Plus, Trash2, Upload, X } from 'lucide-react'
import { useFormatter, useTranslations } from 'next-intl'
import * as React from 'react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import {
  DEFAULT_SMS_MAX_SEGMENTS,
  MAX_SMS_MAX_SEGMENTS,
  SMS_TEMPLATE_KEYS,
  SMS_TEMPLATE_VARIABLES,
  SUBSCRIBER_CHANNELS,
  SUBSCRIBER_DELIVERY_MODES,
  type SubscriberChannel,
  type SubscriberDeliveryMode,
} from '@/lib/status-page-subscribers'
import { cn } from '@/lib/utils'
import type { StatusPage } from '@/payload-types'

import {
  relationId,
  statusPagesApi,
  subscribersApi,
  type OrgId,
  type SubscriberList,
  type SubscriberRow,
} from '../api'
import type { IncidentComponentOption } from './incidents-panel'

export interface SmsChannelOption {
  id: OrgId
  name: string
}

const NONE = '__none__'

type Settings = NonNullable<StatusPage['subscriptions']>

function SettingsCard({
  orgId,
  page,
  onSaved,
  canEdit,
  smsChannels,
}: {
  orgId: OrgId
  page: StatusPage
  onSaved: (page: StatusPage) => void
  canEdit: boolean
  smsChannels: SmsChannelOption[]
}) {
  const t = useTranslations('statusPages.subscribers.settings')
  const tc = useTranslations('statusPages.subscribe.channels')
  const initial = page.subscriptions ?? {}
  const [enabled, setEnabled] = React.useState(Boolean(initial.enabled))
  const [channels, setChannels] = React.useState<SubscriberChannel[]>(
    (initial.channels as SubscriberChannel[] | null | undefined) ?? ['email'],
  )
  const [mode, setMode] = React.useState<SubscriberDeliveryMode>(initial.deliveryMode ?? 'review')
  const [smsChannel, setSmsChannel] = React.useState(
    initial.smsChannel ? relationId(initial.smsChannel) : NONE,
  )
  const [segments, setSegments] = React.useState(initial.smsMaxSegments ?? DEFAULT_SMS_MAX_SEGMENTS)
  const [templates, setTemplates] = React.useState<Record<string, string>>(
    Object.fromEntries(SMS_TEMPLATE_KEYS.map((key) => [key, initial.smsTemplates?.[key] ?? ''])),
  )
  const [saving, setSaving] = React.useState(false)
  const inboundUrl = `/api/status-pages/${page.slug}/sms-inbound`

  async function save(event: React.FormEvent) {
    event.preventDefault()
    setSaving(true)
    try {
      const subscriptions: Settings = {
        enabled,
        channels,
        deliveryMode: mode,
        smsChannel: smsChannel === NONE ? null : (smsChannel as unknown as Settings['smsChannel']),
        smsMaxSegments: segments,
        smsTemplates: Object.fromEntries(
          SMS_TEMPLATE_KEYS.map((key) => [key, templates[key]?.trim() || null]),
        ),
      }
      const { doc } = await statusPagesApi.update(orgId, page.id, { subscriptions })
      onSaved(doc)
      toast.success(t('saved'))
    } catch (error) {
      toast.error(error instanceof Error && error.message ? error.message : t('saveFailed'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={save} className="flex flex-col gap-5 rounded-xl border p-4 sm:p-5">
      <div>
        <h2 className="text-base font-medium">{t('title')}</h2>
        <p className="text-sm text-muted-foreground">{t('description')}</p>
      </div>
      <fieldset disabled={!canEdit} className="flex flex-col gap-5">
        <div className="flex items-center gap-3">
          <Switch id="sp-subscriptions-enabled" checked={enabled} onCheckedChange={setEnabled} />
          <Label htmlFor="sp-subscriptions-enabled">{t('enabled')}</Label>
        </div>

        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 text-sm font-medium">{t('channels')}</legend>
          <div className="flex flex-wrap gap-4">
            {SUBSCRIBER_CHANNELS.map((channel) => (
              <label key={channel} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="accent-primary"
                  checked={channels.includes(channel)}
                  onChange={(e) =>
                    setChannels((list) =>
                      e.target.checked ? [...list, channel] : list.filter((c) => c !== channel),
                    )
                  }
                />
                {tc(channel)}
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset className="grid gap-2">
          <legend className="mb-2 text-sm font-medium">{t('deliveryMode')}</legend>
          {SUBSCRIBER_DELIVERY_MODES.map((value) => (
            <label
              key={value}
              className={cn(
                'flex cursor-pointer items-start gap-3 rounded-xl border px-4 py-3',
                mode === value ? 'border-primary bg-primary/5' : 'hover:bg-muted/50',
              )}
            >
              <input
                type="radio"
                name="sp-delivery-mode"
                value={value}
                checked={mode === value}
                onChange={() => setMode(value)}
                className="mt-1 accent-primary"
              />
              <span className="flex flex-col gap-0.5">
                <span className="text-sm font-medium">{t(`modes.${value}.label`)}</span>
                <span className="text-xs text-muted-foreground">{t(`modes.${value}.hint`)}</span>
              </span>
            </label>
          ))}
        </fieldset>

        {channels.includes('sms') && (
          <div className="flex flex-col gap-4 rounded-lg border border-dashed p-4">
            <div className="grid gap-2">
              <Label htmlFor="sp-sms-channel">{t('smsChannel')}</Label>
              {smsChannels.length === 0 ? (
                <p className="text-xs text-muted-foreground">{t('smsNoChannels')}</p>
              ) : (
                <Select value={smsChannel} onValueChange={setSmsChannel} disabled={!canEdit}>
                  <SelectTrigger id="sp-sms-channel" className="w-full sm:w-72">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>{t('smsChannelNone')}</SelectItem>
                    {smsChannels.map((channel) => (
                      <SelectItem key={String(channel.id)} value={String(channel.id)}>
                        {channel.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              <p className="text-xs break-all text-muted-foreground">
                {t('smsChannelHint', { url: inboundUrl })}
              </p>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="sp-sms-segments">{t('smsMaxSegments')}</Label>
              <Input
                id="sp-sms-segments"
                type="number"
                min={1}
                max={MAX_SMS_MAX_SEGMENTS}
                className="w-24"
                value={segments}
                onChange={(e) => setSegments(Number(e.target.value) || 1)}
              />
            </div>
            <div className="grid gap-3">
              <span className="text-sm font-medium">{t('smsTemplates')}</span>
              <p className="text-xs text-muted-foreground">
                {t('smsTemplatesHint', {
                  placeholders: SMS_TEMPLATE_VARIABLES.map((v) => `{{ ${v} }}`).join(' '),
                })}
              </p>
              {SMS_TEMPLATE_KEYS.map((key) => (
                <div key={key} className="grid gap-1.5">
                  <Label htmlFor={`sp-sms-${key}`} className="text-xs">
                    {t(`templates.${key}`)}
                  </Label>
                  <Textarea
                    id={`sp-sms-${key}`}
                    rows={2}
                    value={templates[key]}
                    onChange={(e) => setTemplates((all) => ({ ...all, [key]: e.target.value }))}
                  />
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="flex justify-end">
          <Button type="submit" disabled={saving}>
            {saving ? t('saving') : t('save')}
          </Button>
        </div>
      </fieldset>
    </form>
  )
}

function AddSubscriberForm({
  orgId,
  pageId,
  components,
  onAdded,
}: {
  orgId: OrgId
  pageId: OrgId
  components: IncidentComponentOption[]
  onAdded: (row: SubscriberRow) => void
}) {
  const t = useTranslations('statusPages.subscribers.add')
  const tc = useTranslations('statusPages.subscribe.channels')
  const tt = useTranslations('statusPages.subscribe.target')
  const [channel, setChannel] = React.useState<SubscriberChannel>('email')
  const [target, setTarget] = React.useState('')
  const [selected, setSelected] = React.useState<string[]>([])
  const [headers, setHeaders] = React.useState<{ name: string; value: string }[]>([])
  const [busy, setBusy] = React.useState(false)
  const [secret, setSecret] = React.useState<string | null>(null)

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    setSecret(null)
    try {
      const { doc } = await subscribersApi.add(orgId, pageId, {
        channel,
        target,
        components: selected,
        ...(channel === 'webhook' ? { headers: headers.filter((h) => h.name.trim()) } : {}),
      })
      onAdded(doc)
      setTarget('')
      setHeaders([])
      if (doc.secret) setSecret(doc.secret)
      toast.success(t('added'))
    } catch (error) {
      toast.error(error instanceof Error && error.message ? error.message : t('addFailed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4 rounded-xl border p-4 sm:p-5">
      <div>
        <h3 className="text-sm font-medium">{t('title')}</h3>
        <p className="text-xs text-muted-foreground">{t('description')}</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-[10rem_minmax(0,1fr)]">
        <div className="grid gap-1.5">
          <Label htmlFor="sp-add-channel">{t('channel')}</Label>
          <Select value={channel} onValueChange={(v) => setChannel(v as SubscriberChannel)}>
            <SelectTrigger id="sp-add-channel">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SUBSCRIBER_CHANNELS.map((value) => (
                <SelectItem key={value} value={value}>
                  {tc(value)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="sp-add-target">{tt(channel)}</Label>
          <Input
            id="sp-add-target"
            value={target}
            required
            onChange={(e) => setTarget(e.target.value)}
          />
        </div>
      </div>
      {components.length > 0 && (
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-medium">{t('components')}</legend>
          <p className="text-xs text-muted-foreground">{t('allComponents')}</p>
          <div className="flex flex-wrap gap-3">
            {components.map((component) => (
              <label key={component.id} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="accent-primary"
                  checked={selected.includes(component.id)}
                  onChange={(e) =>
                    setSelected((list) =>
                      e.target.checked
                        ? [...list, component.id]
                        : list.filter((id) => id !== component.id),
                    )
                  }
                />
                {component.name}
              </label>
            ))}
          </div>
        </fieldset>
      )}
      {channel === 'webhook' && (
        <div className="flex flex-col gap-2">
          {headers.map((header, i) => (
            <div key={i} className="flex gap-2">
              <Input
                aria-label={t('headerName')}
                placeholder={t('headerName')}
                value={header.name}
                onChange={(e) =>
                  setHeaders((list) =>
                    list.map((h, j) => (j === i ? { ...h, name: e.target.value } : h)),
                  )
                }
              />
              <Input
                aria-label={t('headerValue')}
                placeholder={t('headerValue')}
                value={header.value}
                onChange={(e) =>
                  setHeaders((list) =>
                    list.map((h, j) => (j === i ? { ...h, value: e.target.value } : h)),
                  )
                }
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={t('removeHeader')}
                onClick={() => setHeaders((list) => list.filter((_, j) => j !== i))}
              >
                <X aria-hidden />
              </Button>
            </div>
          ))}
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="self-start"
            onClick={() => setHeaders((list) => [...list, { name: '', value: '' }])}
          >
            <Plus aria-hidden /> {t('addHeader')}
          </Button>
        </div>
      )}
      {secret && (
        <div className="rounded-md border bg-muted/40 p-3 text-xs">
          <p className="font-medium">{t('secretTitle')}</p>
          <code className="mt-1 block break-all">{secret}</code>
          <p className="mt-1 text-muted-foreground">{t('secretHint')}</p>
        </div>
      )}
      <div className="flex justify-end">
        <Button type="submit" disabled={busy}>
          {busy ? t('submitting') : t('submit')}
        </Button>
      </div>
    </form>
  )
}

/** Builder tab "Subscribers": settings, owner-added subscribers, the list, CSV import/export. */
export function SubscribersPanel({
  orgId,
  page,
  onSaved,
  canEdit,
  canRead,
  canManage,
  smsChannels,
  components,
}: {
  orgId: OrgId
  page: StatusPage
  onSaved: (page: StatusPage) => void
  canEdit: boolean
  canRead: boolean
  canManage: boolean
  smsChannels: SmsChannelOption[]
  components: IncidentComponentOption[]
}) {
  const t = useTranslations('statusPages.subscribers.list')
  const tc = useTranslations('statusPages.subscribe.channels')
  const format = useFormatter()
  const [list, setList] = React.useState<SubscriberList | null>(null)
  const [query, setQuery] = React.useState('')
  const [pageNumber, setPageNumber] = React.useState(1)
  const [loading, setLoading] = React.useState(false)
  const fileInput = React.useRef<HTMLInputElement>(null)
  const names = React.useMemo(() => new Map(components.map((c) => [c.id, c.name])), [components])

  const load = React.useCallback(async () => {
    if (!canRead) return
    setLoading(true)
    try {
      setList(await subscribersApi.list(orgId, page.id, { page: pageNumber, q: query }))
    } catch {
      toast.error(t('loadFailed'))
    } finally {
      setLoading(false)
    }
  }, [canRead, orgId, page.id, pageNumber, query, t])

  React.useEffect(() => {
    const timer = window.setTimeout(load, 200)
    return () => window.clearTimeout(timer)
  }, [load])

  async function remove(row: SubscriberRow) {
    if (!window.confirm(t('removeConfirm', { target: row.target }))) return
    try {
      await subscribersApi.remove(orgId, page.id, row.id)
      toast.success(t('removed'))
      await load()
    } catch (error) {
      toast.error(error instanceof Error && error.message ? error.message : t('removeFailed'))
    }
  }

  async function importFile(file: File) {
    try {
      const report = await subscribersApi.import(orgId, page.id, file)
      toast.success(t('importDone', { created: report.created, skipped: report.skipped.length }))
      await load()
    } catch (error) {
      toast.error(error instanceof Error && error.message ? error.message : t('importFailed'))
    }
  }

  const confirmedTotal = list
    ? Object.values(list.confirmed).reduce((sum, value) => sum + value, 0)
    : 0

  return (
    <div className="flex flex-col gap-6">
      <SettingsCard
        orgId={orgId}
        page={page}
        onSaved={onSaved}
        canEdit={canEdit}
        smsChannels={smsChannels}
      />
      {canManage && (
        <AddSubscriberForm
          orgId={orgId}
          pageId={page.id}
          components={components}
          onAdded={() => void load()}
        />
      )}
      {canRead && (
        <section className="flex flex-col gap-3">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 className="text-base font-medium">{t('title')}</h2>
              <p className="text-sm text-muted-foreground">
                {t('description', { count: confirmedTotal })}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button asChild variant="outline" size="sm">
                <a href={subscribersApi.exportUrl(orgId, page.id)} download>
                  <Download aria-hidden /> {t('export')}
                </a>
              </Button>
              {canManage && (
                <>
                  <input
                    ref={fileInput}
                    type="file"
                    accept=".csv,text/csv"
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0]
                      if (file) void importFile(file)
                      e.target.value = ''
                    }}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    title={t('importHint')}
                    onClick={() => fileInput.current?.click()}
                  >
                    <Upload aria-hidden /> {t('import')}
                  </Button>
                </>
              )}
            </div>
          </div>
          <Input
            type="search"
            placeholder={t('search')}
            aria-label={t('search')}
            value={query}
            className="sm:w-72"
            onChange={(e) => {
              setQuery(e.target.value)
              setPageNumber(1)
            }}
          />
          {list && list.docs.length === 0 && !loading ? (
            <p className="rounded-xl border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
              {t('empty')}
            </p>
          ) : (
            <div className="overflow-x-auto rounded-xl border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('columns.target')}</TableHead>
                    <TableHead>{t('columns.channel')}</TableHead>
                    <TableHead>{t('columns.components')}</TableHead>
                    <TableHead>{t('columns.status')}</TableHead>
                    <TableHead>{t('columns.added')}</TableHead>
                    {canManage && <TableHead className="w-10" />}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(list?.docs ?? []).map((row) => (
                    <TableRow key={String(row.id)}>
                      <TableCell className="max-w-64 truncate font-mono text-xs" title={row.target}>
                        {row.target}
                        {row.lastError && (
                          <span className="block truncate font-sans text-destructive">
                            {t('lastError', { error: row.lastError })}
                          </span>
                        )}
                      </TableCell>
                      <TableCell>{tc(row.channel)}</TableCell>
                      <TableCell
                        className="text-xs"
                        title={row.components.map((id) => names.get(id) ?? id).join(', ')}
                      >
                        {row.components.length === 0
                          ? t('allComponents')
                          : t('componentCount', { count: row.components.length })}
                      </TableCell>
                      <TableCell>
                        <span className="flex flex-wrap gap-1">
                          {row.confirmedAt ? (
                            <Badge className="bg-status-up/15 text-foreground">
                              {t('confirmed')}
                            </Badge>
                          ) : (
                            <Badge variant="secondary">{t('pending')}</Badge>
                          )}
                          <Badge variant="outline">{t(`sources.${row.source}`)}</Badge>
                        </span>
                      </TableCell>
                      <TableCell className="text-xs whitespace-nowrap tabular-nums">
                        {format.dateTime(new Date(row.createdAt), 'date')}
                      </TableCell>
                      {canManage && (
                        <TableCell>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            aria-label={t('remove')}
                            onClick={() => void remove(row)}
                          >
                            <Trash2 aria-hidden />
                          </Button>
                        </TableCell>
                      )}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
          {list && list.totalPages > 1 && (
            <div className="flex items-center justify-end gap-2 text-sm">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={pageNumber <= 1}
                onClick={() => setPageNumber((n) => n - 1)}
              >
                {t('previous')}
              </Button>
              <span className="text-muted-foreground">
                {t('pageOf', { page: list.page, total: list.totalPages })}
              </span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={pageNumber >= list.totalPages}
                onClick={() => setPageNumber((n) => n + 1)}
              >
                {t('next')}
              </Button>
            </div>
          )}
        </section>
      )}
    </div>
  )
}
