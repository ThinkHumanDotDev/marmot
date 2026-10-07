'use client'

import { CheckCircle2, Pencil, Pin, PinOff, Plus, RotateCcw, Trash2 } from 'lucide-react'
import { useFormatter, useTranslations } from 'next-intl'
import * as React from 'react'
import { toast } from 'sonner'

import { INCIDENT_STYLES } from '@/collections/Incidents'
import { Badge } from '@/components/ui/badge'
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
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import type { Incident } from '@/payload-types'

import { statusPagesApi, type IncidentPatch, type OrgId } from '../api'

const styleBadge: Record<NonNullable<Incident['style']>, string> = {
  info: 'bg-status-maintenance/15',
  warning: 'bg-status-pending/20',
  danger: 'bg-status-down/15',
  primary: 'bg-primary/15',
}

type Draft = Required<Pick<IncidentPatch, 'title' | 'content' | 'style' | 'pinned'>>

const emptyDraft: Draft = { title: '', content: '', style: 'info', pinned: true }

export function IncidentsPanel({
  orgId,
  pageId,
  initialIncidents,
  canEdit,
  timeZone,
}: {
  orgId: OrgId
  pageId: OrgId
  initialIncidents: Incident[]
  canEdit: boolean
  /** Organization time zone the timestamps render in. */
  timeZone: string
}) {
  const t = useTranslations('statusPages.incidents')
  const format = useFormatter()
  const formatTime = (iso: string) => format.dateTime(new Date(iso), 'short', { timeZone })
  const [incidents, setIncidents] = React.useState(initialIncidents)
  const [editing, setEditing] = React.useState<Incident | 'new' | null>(null)
  const [draft, setDraft] = React.useState<Draft>(emptyDraft)
  const [pending, setPending] = React.useState(false)

  const upsert = (doc: Incident) =>
    setIncidents((list) => {
      const idx = list.findIndex((i) => String(i.id) === String(doc.id))
      if (idx < 0) return [doc, ...list]
      const next = list.slice()
      next[idx] = doc
      return next
    })

  function openNew() {
    setDraft(emptyDraft)
    setEditing('new')
  }

  function openEdit(incident: Incident) {
    setDraft({
      title: incident.title,
      content: incident.content ?? '',
      style: incident.style ?? 'info',
      pinned: Boolean(incident.pinned),
    })
    setEditing(incident)
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (!editing) return
    setPending(true)
    try {
      const data = { ...draft, content: draft.content || null }
      const { doc } =
        editing === 'new'
          ? await statusPagesApi.incidents.create(orgId, pageId, data)
          : await statusPagesApi.incidents.update(orgId, pageId, editing.id, data)
      upsert(doc)
      setEditing(null)
      toast.success(editing === 'new' ? t('posted') : t('updated'))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('saveFailed'))
    } finally {
      setPending(false)
    }
  }

  async function patch(incident: Incident, data: IncidentPatch, message: string) {
    try {
      const { doc } = await statusPagesApi.incidents.update(orgId, pageId, incident.id, data)
      upsert(doc)
      toast.success(message)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('updateFailed'))
    }
  }

  async function remove(incident: Incident) {
    if (!window.confirm(t('confirmDelete', { title: incident.title }))) return
    try {
      await statusPagesApi.incidents.remove(orgId, pageId, incident.id)
      setIncidents((list) => list.filter((i) => String(i.id) !== String(incident.id)))
      toast.success(t('deleted'))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('deleteFailed'))
    }
  }

  const active = incidents.filter((i) => i.active !== false)
  const resolved = incidents.filter((i) => i.active === false)

  const renderRow = (incident: Incident) => (
    <li
      key={incident.id}
      className="flex flex-wrap items-start justify-between gap-3 rounded-xl border bg-card px-4 py-3"
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{incident.title}</span>
          <Badge className={cn('text-foreground', styleBadge[incident.style ?? 'info'])}>
            {t(`styles.${incident.style ?? 'info'}`)}
          </Badge>
          {incident.pinned && <Badge variant="outline">{t('pinnedBadge')}</Badge>}
          {incident.active === false && <Badge variant="secondary">{t('resolvedBadge')}</Badge>}
        </div>
        {incident.content && (
          <p className="mt-1 line-clamp-2 text-sm whitespace-pre-line text-muted-foreground">
            {incident.content}
          </p>
        )}
        <p className="mt-1 text-xs text-muted-foreground">
          {formatTime(incident.createdAt)}
          {incident.resolvedAt && t('resolvedAt', { time: formatTime(incident.resolvedAt) })}
        </p>
      </div>
      {canEdit && (
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t('edit')}
            onClick={() => openEdit(incident)}
          >
            <Pencil />
          </Button>
          {incident.active !== false && (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={incident.pinned ? t('unpin') : t('pin')}
              onClick={() =>
                patch(
                  incident,
                  { pinned: !incident.pinned },
                  incident.pinned ? t('unpinned') : t('pinned'),
                )
              }
            >
              {incident.pinned ? <PinOff /> : <Pin />}
            </Button>
          )}
          {incident.active !== false ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={t('resolve')}
              onClick={() => patch(incident, { active: false }, t('resolved'))}
            >
              <CheckCircle2 />
            </Button>
          ) : (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={t('reopen')}
              onClick={() => patch(incident, { active: true }, t('reopened'))}
            >
              <RotateCcw />
            </Button>
          )}
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t('delete')}
            onClick={() => remove(incident)}
          >
            <Trash2 />
          </Button>
        </div>
      )}
    </li>
  )

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <Label className="text-base">{t('title')}</Label>
          <p className="text-sm text-muted-foreground">{t('description')}</p>
        </div>
        <Button type="button" size="sm" disabled={!canEdit} onClick={openNew}>
          <Plus /> {t('post')}
        </Button>
      </div>

      {incidents.length === 0 ? (
        <p className="rounded-xl border border-dashed px-5 py-10 text-center text-sm text-muted-foreground">
          {t('empty')}
        </p>
      ) : (
        <>
          {active.length > 0 && <ul className="flex flex-col gap-2">{active.map(renderRow)}</ul>}
          {resolved.length > 0 && (
            <div className="flex flex-col gap-2">
              <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                {t('resolvedHeading')}
              </h3>
              <ul className="flex flex-col gap-2 opacity-80">{resolved.map(renderRow)}</ul>
            </div>
          )}
        </>
      )}

      <Dialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent>
          <form onSubmit={submit} className="flex flex-col gap-5">
            <DialogHeader>
              <DialogTitle>
                {editing === 'new' ? t('dialog.postTitle') : t('dialog.editTitle')}
              </DialogTitle>
              <DialogDescription>{t('dialog.description')}</DialogDescription>
            </DialogHeader>
            <div className="grid gap-2">
              <Label htmlFor="incident-title">{t('dialog.title')}</Label>
              <Input
                id="incident-title"
                value={draft.title}
                required
                autoFocus
                onChange={(e) => setDraft({ ...draft, title: e.target.value })}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="incident-content">{t('dialog.details')}</Label>
              <Textarea
                id="incident-content"
                rows={5}
                value={draft.content ?? ''}
                onChange={(e) => setDraft({ ...draft, content: e.target.value })}
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="grid gap-2">
                <Label htmlFor="incident-style">{t('dialog.style')}</Label>
                <Select
                  value={draft.style ?? 'info'}
                  onValueChange={(v) => setDraft({ ...draft, style: v as Draft['style'] })}
                >
                  <SelectTrigger id="incident-style">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {INCIDENT_STYLES.map((style) => (
                      <SelectItem key={style} value={style}>
                        {t(`styles.${style}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-center justify-between gap-3 self-end py-2">
                <Label htmlFor="incident-pinned">{t('dialog.pinToTop')}</Label>
                <Switch
                  id="incident-pinned"
                  checked={Boolean(draft.pinned)}
                  onCheckedChange={(v) => setDraft({ ...draft, pinned: v })}
                />
              </div>
            </div>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setEditing(null)}>
                {t('dialog.cancel')}
              </Button>
              <Button type="submit" disabled={pending || !draft.title.trim()}>
                {pending
                  ? t('dialog.saving')
                  : editing === 'new'
                    ? t('dialog.post')
                    : t('dialog.save')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}
