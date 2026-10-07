'use client'

import {
  Check,
  Copy,
  KeyRound,
  ListTree,
  MoreHorizontal,
  Pencil,
  Plus,
  Send,
  Trash2,
  Webhook,
} from 'lucide-react'
import Link from 'next/link'
import { useFormatter, useTranslations } from 'next-intl'
import * as React from 'react'
import { toast } from 'sonner'

import { EmptyState } from '@/components/empty-state'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { WEBHOOK_WILDCARD, type WebhookEventGroup } from '@/lib/webhook-events'
import type { WebhookEndpointRow } from '@/lib/webhooks'
import { webhooksApi } from '@/lib/webhooks-api'

interface WebhooksViewProps {
  orgId: string
  orgSlug: string
  initial: WebhookEndpointRow[]
  eventGroups: readonly WebhookEventGroup[]
  /** `webhook:manage` (admins and owners by default). */
  canManage: boolean
}

function EndpointStatus({ row }: { row: WebhookEndpointRow }) {
  const t = useTranslations('settings.webhooks.status')
  if (row.active) return <Badge variant="outline">{t('active')}</Badge>
  if (row.disabledReason === 'failures') {
    return <Badge variant="destructive">{t('disabledFailures')}</Badge>
  }
  return <Badge variant="secondary">{t('disabled')}</Badge>
}

/** Settings → Webhooks: endpoints, their events, secrets (shown once), tests and the delivery log. */
export function WebhooksView({
  orgId,
  orgSlug,
  initial,
  eventGroups,
  canManage,
}: WebhooksViewProps) {
  const t = useTranslations('settings.webhooks')
  const format = useFormatter()
  const [rows, setRows] = React.useState<WebhookEndpointRow[]>(initial)
  const [editing, setEditing] = React.useState<WebhookEndpointRow | 'new' | null>(null)
  const [revealed, setRevealed] = React.useState<{ url: string; secret: string } | null>(null)
  const [deleting, setDeleting] = React.useState<WebhookEndpointRow | null>(null)
  const [rotating, setRotating] = React.useState<WebhookEndpointRow | null>(null)
  const [busyId, setBusyId] = React.useState<string | null>(null)

  const upsert = (row: WebhookEndpointRow) =>
    setRows((current) =>
      current.some((r) => r.id === row.id)
        ? current.map((r) => (r.id === row.id ? row : r))
        : [row, ...current],
    )

  const failureMessage = (error: unknown, fallback: string) =>
    error instanceof Error && error.message ? error.message : fallback

  async function toggleActive(row: WebhookEndpointRow, active: boolean) {
    setBusyId(row.id)
    try {
      const { doc } = await webhooksApi.update(orgId, row.id, { active })
      upsert(doc)
      toast.success(active ? t('enabled') : t('disabledToast'))
    } catch (error) {
      toast.error(failureMessage(error, t('updateFailed')))
    } finally {
      setBusyId(null)
    }
  }

  async function sendTest(row: WebhookEndpointRow) {
    setBusyId(row.id)
    try {
      const { delivery } = await webhooksApi.test(orgId, row.id)
      if (delivery?.state === 'succeeded') {
        toast.success(t('testSucceeded', { status: delivery.responseStatus ?? 0 }))
      } else {
        toast.error(t('testFailed', { error: delivery?.error ?? '' }))
      }
    } catch (error) {
      toast.error(failureMessage(error, t('testFailed', { error: '' })))
    } finally {
      setBusyId(null)
    }
  }

  async function confirmRotate() {
    if (!rotating) return
    setBusyId(rotating.id)
    try {
      const { doc, secret } = await webhooksApi.rotateSecret(orgId, rotating.id)
      upsert(doc)
      setRotating(null)
      setRevealed({ url: doc.url, secret })
    } catch (error) {
      toast.error(failureMessage(error, t('rotateFailed')))
    } finally {
      setBusyId(null)
    }
  }

  async function confirmDelete() {
    if (!deleting) return
    setBusyId(deleting.id)
    try {
      await webhooksApi.remove(orgId, deleting.id)
      setRows((current) => current.filter((r) => r.id !== deleting.id))
      toast.success(t('deleted'))
      setDeleting(null)
    } catch (error) {
      toast.error(failureMessage(error, t('deleteFailed')))
    } finally {
      setBusyId(null)
    }
  }

  const eventsSummary = (events: string[]) =>
    events.includes(WEBHOOK_WILDCARD) ? t('allEvents') : t('eventCount', { count: events.length })

  return (
    <>
      <Card data-testid="webhooks-card">
        <CardHeader className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1">
            <CardTitle className="flex items-center gap-2">
              <Webhook className="size-4 text-muted-foreground" aria-hidden /> {t('title')}
            </CardTitle>
            <CardDescription>
              {t.rich('description', { code: (chunks) => <code>{chunks}</code> })}
            </CardDescription>
          </div>
          {canManage && (
            <Button onClick={() => setEditing('new')}>
              <Plus /> {t('newEndpoint')}
            </Button>
          )}
        </CardHeader>
        <CardContent>
          {rows.length === 0 ? (
            <EmptyState
              icon={Webhook}
              title={t('emptyTitle')}
              description={canManage ? t('emptyDescription') : t('emptyReadOnly')}
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('columns.endpoint')}</TableHead>
                  <TableHead>{t('columns.events')}</TableHead>
                  <TableHead>{t('columns.status')}</TableHead>
                  <TableHead>{t('columns.lastDelivery')}</TableHead>
                  <TableHead className="w-0" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row.id} data-testid={`webhook-${row.id}`}>
                    <TableCell className="max-w-64">
                      <div className="truncate font-mono text-xs" title={row.url}>
                        {row.url}
                      </div>
                      {row.description && (
                        <div className="truncate text-xs text-muted-foreground">
                          {row.description}
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {eventsSummary(row.events)}
                    </TableCell>
                    <TableCell>
                      <EndpointStatus row={row} />
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {row.lastDeliveryAt
                        ? t('lastDelivery', {
                            state: row.lastDeliveryState ?? 'none',
                            time: format.dateTime(new Date(row.lastDeliveryAt), 'short'),
                          })
                        : t('never')}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center justify-end gap-2">
                        {canManage && (
                          <Switch
                            checked={row.active}
                            disabled={busyId === row.id}
                            onCheckedChange={(checked) => toggleActive(row, checked)}
                            aria-label={row.active ? t('disableEndpoint') : t('enableEndpoint')}
                          />
                        )}
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              aria-label={t('actionsLabel', { url: row.url })}
                              disabled={busyId === row.id}
                            >
                              <MoreHorizontal />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem asChild>
                              <Link href={`/${orgSlug}/settings/webhooks/${row.id}`}>
                                <ListTree /> {t('viewDeliveries')}
                              </Link>
                            </DropdownMenuItem>
                            {canManage && (
                              <>
                                <DropdownMenuItem onSelect={() => sendTest(row)}>
                                  <Send /> {t('sendTest')}
                                </DropdownMenuItem>
                                <DropdownMenuItem onSelect={() => setEditing(row)}>
                                  <Pencil /> {t('edit')}
                                </DropdownMenuItem>
                                <DropdownMenuItem onSelect={() => setRotating(row)}>
                                  <KeyRound /> {t('rotateSecret')}
                                </DropdownMenuItem>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem
                                  variant="destructive"
                                  onSelect={() => setDeleting(row)}
                                >
                                  <Trash2 /> {t('delete')}
                                </DropdownMenuItem>
                              </>
                            )}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {canManage && (
        <EndpointDialog
          orgId={orgId}
          editing={editing}
          eventGroups={eventGroups}
          onClose={() => setEditing(null)}
          onSaved={(row, secret) => {
            upsert(row)
            if (secret) setRevealed({ url: row.url, secret })
          }}
        />
      )}

      <RevealSecretDialog revealed={revealed} onClose={() => setRevealed(null)} />

      <Dialog open={rotating !== null} onOpenChange={(open) => !open && setRotating(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('rotateTitle')}</DialogTitle>
            <DialogDescription>{t('rotateDescription')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRotating(null)}>
              {t('cancel')}
            </Button>
            <Button onClick={confirmRotate} disabled={busyId === rotating?.id}>
              <KeyRound /> {t('rotateSecret')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={deleting !== null} onOpenChange={(open) => !open && setDeleting(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('deleteTitle')}</DialogTitle>
            <DialogDescription>
              {t('deleteDescription', { url: deleting?.url ?? '' })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleting(null)}>
              {t('cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={confirmDelete}
              disabled={busyId === deleting?.id}
            >
              <Trash2 /> {t('delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

interface EndpointDialogProps {
  orgId: string
  editing: WebhookEndpointRow | 'new' | null
  eventGroups: readonly WebhookEventGroup[]
  onClose: () => void
  onSaved: (row: WebhookEndpointRow, secret: string | null) => void
}

function EndpointDialog({ editing, onClose, ...rest }: EndpointDialogProps) {
  return (
    <Dialog open={editing !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-xl">
        {editing && (
          <EndpointForm
            key={editing === 'new' ? 'new' : editing.id}
            existing={editing === 'new' ? null : editing}
            onClose={onClose}
            {...rest}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

function EndpointForm({
  orgId,
  existing,
  eventGroups,
  onClose,
  onSaved,
}: Omit<EndpointDialogProps, 'editing'> & { existing: WebhookEndpointRow | null }) {
  const t = useTranslations('settings.webhooks.form')
  const [url, setUrl] = React.useState(existing?.url ?? '')
  const [description, setDescription] = React.useState(existing?.description ?? '')
  const [events, setEvents] = React.useState<string[]>(
    existing?.events.length ? existing.events : [WEBHOOK_WILDCARD],
  )
  const [busy, setBusy] = React.useState(false)

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (!url.trim() || events.length === 0) return
    setBusy(true)
    const data = { url: url.trim(), description: description.trim() || null, events }
    try {
      if (existing) {
        const { doc } = await webhooksApi.update(orgId, existing.id, data)
        onSaved(doc, null)
      } else {
        const { doc, secret } = await webhooksApi.create(orgId, data)
        onSaved(doc, secret)
      }
      onClose()
    } catch (error) {
      toast.error(error instanceof Error && error.message ? error.message : t('failed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-6">
      <DialogHeader>
        <DialogTitle>{existing ? t('editTitle') : t('createTitle')}</DialogTitle>
        <DialogDescription>{t('description')}</DialogDescription>
      </DialogHeader>
      <div className="flex flex-col gap-4">
        <div className="grid gap-2">
          <Label htmlFor="webhook-url">{t('url')}</Label>
          <Input
            id="webhook-url"
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder={t('urlPlaceholder')}
            maxLength={2048}
            autoFocus
            required
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="webhook-description">{t('descriptionLabel')}</Label>
          <Input
            id="webhook-description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={t('descriptionPlaceholder')}
            maxLength={200}
          />
        </div>
        <EventPicker groups={eventGroups} value={events} onChange={setEvents} />
      </div>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          {t('cancel')}
        </Button>
        <Button type="submit" disabled={busy || !url.trim() || events.length === 0}>
          <Webhook /> {existing ? t('save') : t('create')}
        </Button>
      </DialogFooter>
    </form>
  )
}

const checkboxClass = 'size-4 accent-primary disabled:opacity-60'

/** All events, or a selection of groups (`incident.*`) and single event types. */
function EventPicker({
  groups,
  value,
  onChange,
}: {
  groups: readonly WebhookEventGroup[]
  value: string[]
  onChange: (next: string[]) => void
}) {
  const t = useTranslations('settings.webhooks.form')
  const tEntity = useTranslations('settings.auditLog.entities')
  type EntityKey = Parameters<typeof tEntity>[0]
  const entityLabel = (group: string) =>
    tEntity.has(group as EntityKey) ? tEntity(group as EntityKey) : group
  const all = value.includes(WEBHOOK_WILDCARD)

  const toggle = (selector: string, on: boolean) => {
    const rest = value.filter((v) => v !== selector && v !== WEBHOOK_WILDCARD)
    if (!on) return onChange(rest)
    // A group wildcard replaces the single events it covers.
    const prefix = selector.endsWith('.*') ? selector.slice(0, -1) : null
    onChange([...rest.filter((v) => !prefix || !v.startsWith(prefix)), selector])
  }

  return (
    <fieldset className="grid gap-3">
      <legend className="mb-2 text-sm font-medium">{t('events')}</legend>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="radio"
          name="webhook-events-mode"
          className={checkboxClass}
          checked={all}
          onChange={() => onChange([WEBHOOK_WILDCARD])}
        />
        {t('allEvents')}
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="radio"
          name="webhook-events-mode"
          className={checkboxClass}
          checked={!all}
          onChange={() => onChange([])}
        />
        {t('selectedEvents')}
      </label>
      {!all && (
        <div className="max-h-72 space-y-4 overflow-y-auto rounded-md border p-3">
          {groups.map(({ group, events }) => {
            const wildcard = `${group}.*`
            const groupOn = value.includes(wildcard)
            return (
              <div key={group} className="space-y-1.5">
                <label className="flex items-center gap-2 text-sm font-medium">
                  <input
                    type="checkbox"
                    className={checkboxClass}
                    checked={groupOn}
                    onChange={(e) => toggle(wildcard, e.target.checked)}
                  />
                  {t('groupAll', { group: entityLabel(group) })}
                </label>
                <div className="grid gap-1 pl-6 sm:grid-cols-2">
                  {events.map((type) => (
                    <label key={type} className="flex items-center gap-2 font-mono text-xs">
                      <input
                        type="checkbox"
                        className={checkboxClass}
                        disabled={groupOn}
                        checked={groupOn || value.includes(type)}
                        onChange={(e) => toggle(type, e.target.checked)}
                      />
                      {type}
                    </label>
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      )}
      {!all && value.length === 0 && (
        <p className="text-sm text-destructive">{t('eventsRequired')}</p>
      )}
    </fieldset>
  )
}

function RevealSecretDialog({
  revealed,
  onClose,
}: {
  revealed: { url: string; secret: string } | null
  onClose: () => void
}) {
  const t = useTranslations('settings.webhooks.reveal')
  const [copied, setCopied] = React.useState(false)

  async function copy() {
    if (!revealed) return
    try {
      await navigator.clipboard.writeText(revealed.secret)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      toast.error(t('copyFailed'))
    }
  }

  return (
    <Dialog open={revealed !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>
            {t.rich('description', {
              url: revealed?.url ?? '',
              code: (chunks) => <code>{chunks}</code>,
            })}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <Input
            readOnly
            value={revealed?.secret ?? ''}
            aria-label={t('secretLabel')}
            onFocus={(e) => e.currentTarget.select()}
            className="font-mono text-xs"
            data-testid="webhook-secret"
          />
          <Button variant="outline" onClick={copy} aria-label={t('copyLabel')}>
            {copied ? <Check /> : <Copy />} {copied ? t('copied') : t('copy')}
          </Button>
        </div>
        <DialogFooter>
          <Button onClick={onClose}>{t('done')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
