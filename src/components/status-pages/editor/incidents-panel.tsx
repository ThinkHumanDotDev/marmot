'use client'

import { ChevronDown, ChevronUp, Pencil, Pin, PinOff, Plus, Trash2, X } from 'lucide-react'
import { useFormatter, useTranslations } from 'next-intl'
import * as React from 'react'
import { toast } from 'sonner'

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
import {
  COMPONENT_IMPACTS,
  INCIDENT_STATUSES,
  incidentTimeline,
  type ComponentImpact,
  type IncidentStatus,
  type TimelineUpdate,
} from '@/lib/incident-timeline'
import { renderMarkdown } from '@/lib/markdown'
import { cn } from '@/lib/utils'
import type { Incident } from '@/payload-types'

import { statusPagesApi, type IncidentPatch, type IncidentUpdateDraft, type OrgId } from '../api'

/** A component of the page an incident can affect: a group row (monitor or static), by row id. */
export interface IncidentComponentOption {
  id: string
  name: string
}

export const impactBadge: Record<ComponentImpact, string> = {
  operational: 'bg-status-up/15',
  degraded_performance: 'bg-status-pending/20',
  partial_outage: 'bg-status-pending/35',
  major_outage: 'bg-status-down/20',
}

/** Suggested status for the next update: the timeline usually moves forward one step. */
const NEXT_STATUS: Record<IncidentStatus, IncidentStatus> = {
  investigating: 'identified',
  identified: 'monitoring',
  monitoring: 'resolved',
  resolved: 'investigating',
}

type ImpactMap = Record<string, ComponentImpact>

const MARKDOWN_CLASS =
  'max-w-none text-sm leading-relaxed [&_a]:underline [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_p+p]:mt-2 [&_ul]:list-disc [&_ul]:pl-5'

function useLabels() {
  const t = useTranslations('statusPages.public')
  return {
    status: (status: IncidentStatus) => t(`incidents.status.${status}`),
    impact: (impact: ComponentImpact) => t(`impact.${impact}`),
  }
}

/**
 * Editor for "which components does this update affect, and how badly". Rows can be added from
 * the page's components and removed; `locked` rows (current impacts of the incident) can be changed
 * but not removed, since leaving a component out of an update keeps its impact anyway.
 */
function ComponentImpactEditor({
  idPrefix,
  options,
  value,
  onChange,
  locked = [],
}: {
  idPrefix: string
  options: IncidentComponentOption[]
  value: ImpactMap
  onChange: (next: ImpactMap) => void
  locked?: string[]
}) {
  const t = useTranslations('statusPages.incidents.components')
  const labels = useLabels()
  const nameOf = (id: string) => options.find((o) => o.id === id)?.name ?? t('unknown')
  const selected = Object.keys(value)
  const available = options.filter((o) => !(o.id in value))

  if (options.length === 0 && selected.length === 0) {
    return <p className="text-xs text-muted-foreground">{t('none')}</p>
  }

  return (
    <div className="flex flex-col gap-2">
      {selected.length > 0 && (
        <ul className="flex flex-col gap-2">
          {selected.map((id) => (
            <li key={id} className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-sm">{nameOf(id)}</span>
              <Select
                value={value[id]}
                onValueChange={(impact) => onChange({ ...value, [id]: impact as ComponentImpact })}
              >
                <SelectTrigger
                  id={`${idPrefix}-impact-${id}`}
                  aria-label={t('impact', { name: nameOf(id) })}
                  className="w-48"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {COMPONENT_IMPACTS.map((impact) => (
                    <SelectItem key={impact} value={impact}>
                      {labels.impact(impact)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {!locked.includes(id) && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t('remove', { name: nameOf(id) })}
                  onClick={() => {
                    const next = { ...value }
                    delete next[id]
                    onChange(next)
                  }}
                >
                  <X />
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {available.length > 0 && (
        <Select value="" onValueChange={(id) => onChange({ ...value, [id]: 'major_outage' })}>
          <SelectTrigger id={`${idPrefix}-add`} aria-label={t('add')} className="w-full sm:w-64">
            <SelectValue placeholder={t('addPlaceholder')} />
          </SelectTrigger>
          <SelectContent>
            {available.map((option) => (
              <SelectItem key={option.id} value={option.id}>
                {option.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </div>
  )
}

function StatusSelect({
  id,
  value,
  onChange,
}: {
  id: string
  value: IncidentStatus
  onChange: (status: IncidentStatus) => void
}) {
  const labels = useLabels()
  return (
    <Select value={value} onValueChange={(v) => onChange(v as IncidentStatus)}>
      <SelectTrigger id={id} className="w-full sm:w-48">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {INCIDENT_STATUSES.map((status) => (
          <SelectItem key={status} value={status}>
            {labels.status(status)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

function ImpactSelect({
  id,
  value,
  onChange,
}: {
  id: string
  value: ComponentImpact
  onChange: (impact: ComponentImpact) => void
}) {
  const labels = useLabels()
  return (
    <Select value={value} onValueChange={(v) => onChange(v as ComponentImpact)}>
      <SelectTrigger id={id} className="w-full sm:w-56">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {COMPONENT_IMPACTS.map((impact) => (
          <SelectItem key={impact} value={impact}>
            {labels.impact(impact)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

/** Inline "post update" form under an incident's header. */
function UpdateComposer({
  incident,
  options,
  onPost,
}: {
  incident: Incident
  options: IncidentComponentOption[]
  onPost: (data: IncidentUpdateDraft) => Promise<boolean>
}) {
  const t = useTranslations('statusPages.incidents')
  const { state } = incidentTimeline(incident)
  // The parent remounts the composer (via `key`) when the current impacts change.
  const current = Object.fromEntries(
    state.components.map((c) => [c.component, c.impact]),
  ) as ImpactMap
  const [status, setStatus] = React.useState<IncidentStatus>(NEXT_STATUS[state.status])
  const [message, setMessage] = React.useState('')
  const [impacts, setImpacts] = React.useState<ImpactMap>(current)
  const [declared, setDeclared] = React.useState<ComponentImpact>(state.impact)
  const [pending, setPending] = React.useState(false)
  const idPrefix = `incident-${incident.id}-composer`

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setPending(true)
    // Send only what changed: components left out keep their impact.
    const components = Object.entries(impacts)
      .filter(([id, impact]) => current[id] !== impact)
      .map(([component, impact]) => ({ component, impact }))
    const componentless = Object.keys(impacts).length === 0
    const resolving = status === 'resolved'
    const ok = await onPost({
      status,
      message,
      components: resolving ? [] : components,
      ...(componentless && !resolving ? { impact: declared } : {}),
    })
    setPending(false)
    if (ok) {
      setMessage('')
      setStatus(NEXT_STATUS[status])
    }
  }

  return (
    <form
      onSubmit={submit}
      className="flex flex-col gap-3 rounded-lg border border-dashed p-3"
      aria-label={t('composer.title')}
    >
      <div className="flex flex-wrap items-end gap-3">
        <div className="grid gap-1.5">
          <Label htmlFor={`${idPrefix}-status`}>{t('composer.status')}</Label>
          <StatusSelect id={`${idPrefix}-status`} value={status} onChange={setStatus} />
        </div>
        {status === 'resolved' && (
          <p className="pb-2 text-xs text-muted-foreground">{t('composer.resolveHint')}</p>
        )}
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor={`${idPrefix}-message`}>{t('composer.message')}</Label>
        <Textarea
          id={`${idPrefix}-message`}
          rows={3}
          value={message}
          placeholder={t('composer.messagePlaceholder')}
          onChange={(e) => setMessage(e.target.value)}
        />
      </div>
      {status !== 'resolved' && (
        <div className="grid gap-1.5">
          <Label>{t('components.title')}</Label>
          <p className="text-xs text-muted-foreground">{t('components.hint')}</p>
          <ComponentImpactEditor
            idPrefix={idPrefix}
            options={options}
            value={impacts}
            onChange={setImpacts}
            locked={Object.keys(current)}
          />
          {Object.keys(impacts).length === 0 && (
            <div className="grid gap-1.5 pt-1">
              <Label htmlFor={`${idPrefix}-declared`}>{t('components.overallImpact')}</Label>
              <ImpactSelect id={`${idPrefix}-declared`} value={declared} onChange={setDeclared} />
              <p className="text-xs text-muted-foreground">{t('components.overallImpactHint')}</p>
            </div>
          )}
        </div>
      )}
      <div className="flex justify-end">
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? t('composer.posting') : t('composer.post')}
        </Button>
      </div>
    </form>
  )
}

/** One entry of the editor timeline, with inline text editing. */
function TimelineEntry({
  update,
  options,
  canEdit,
  timeZone,
  onEdit,
}: {
  update: TimelineUpdate
  options: IncidentComponentOption[]
  canEdit: boolean
  timeZone: string
  onEdit: (message: string) => Promise<boolean>
}) {
  const t = useTranslations('statusPages.incidents')
  const labels = useLabels()
  const format = useFormatter()
  const [editing, setEditing] = React.useState(false)
  const [draft, setDraft] = React.useState(update.message ?? '')
  const [pending, setPending] = React.useState(false)
  const nameOf = (id: string) => options.find((o) => o.id === id)?.name ?? t('components.unknown')

  async function save() {
    setPending(true)
    const ok = await onEdit(draft)
    setPending(false)
    if (ok) setEditing(false)
  }

  return (
    <li className="relative border-l-2 pb-4 pl-4 last:pb-0" data-update-status={update.status}>
      <span
        className="absolute top-1.5 -left-[5px] size-2 rounded-full bg-muted-foreground"
        aria-hidden
      />
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-sm font-medium">{labels.status(update.status)}</span>
        <time dateTime={update.postedAt} className="text-xs text-muted-foreground">
          {format.dateTime(new Date(update.postedAt), 'short', { timeZone })}
        </time>
        {update.editedAt && (
          <span
            className="text-xs text-muted-foreground italic"
            title={t('editedTitle', {
              time: format.dateTime(new Date(update.editedAt), 'short', { timeZone }),
            })}
          >
            ({t('edited')})
          </span>
        )}
        {canEdit && !editing && (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t('editUpdate')}
            onClick={() => {
              setDraft(update.message ?? '')
              setEditing(true)
            }}
          >
            <Pencil />
          </Button>
        )}
      </div>
      {editing ? (
        <div className="mt-2 flex flex-col gap-2">
          <Textarea
            rows={3}
            value={draft}
            aria-label={t('editUpdate')}
            onChange={(e) => setDraft(e.target.value)}
          />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(false)}>
              {t('cancel')}
            </Button>
            <Button type="button" size="sm" disabled={pending} onClick={save}>
              {t('saveUpdate')}
            </Button>
          </div>
        </div>
      ) : update.message ? (
        <div
          className={cn('mt-1', MARKDOWN_CLASS)}
          dangerouslySetInnerHTML={{ __html: renderMarkdown(update.message) }}
        />
      ) : (
        <p className="mt-1 text-sm text-muted-foreground">{t('noMessage')}</p>
      )}
      {(update.components ?? []).length > 0 && (
        <ul className="mt-2 flex flex-wrap gap-1">
          {(update.components ?? []).map((c) => (
            <li key={c.component}>
              <Badge className={cn('text-foreground', impactBadge[c.impact])}>
                {nameOf(c.component)}: {labels.impact(c.impact)}
              </Badge>
            </li>
          ))}
        </ul>
      )}
    </li>
  )
}

function IncidentItem({
  incident,
  options,
  canEdit,
  timeZone,
  orgId,
  pageId,
  onSaved,
  onRename,
  onRemove,
}: {
  incident: Incident
  options: IncidentComponentOption[]
  canEdit: boolean
  timeZone: string
  orgId: OrgId
  pageId: OrgId
  onSaved: (doc: Incident) => void
  onRename: (incident: Incident) => void
  onRemove: (incident: Incident) => void
}) {
  const t = useTranslations('statusPages.incidents')
  const labels = useLabels()
  const format = useFormatter()
  const { updates, state } = incidentTimeline(incident)
  const [expanded, setExpanded] = React.useState(state.active)
  const formatTime = (iso: string) => format.dateTime(new Date(iso), 'short', { timeZone })
  const newestFirst = updates.slice().reverse()
  const nameOf = (id: string) => options.find((o) => o.id === id)?.name ?? t('components.unknown')

  async function patch(data: IncidentPatch, message: string) {
    try {
      const { doc } = await statusPagesApi.incidents.update(orgId, pageId, incident.id, data)
      onSaved(doc)
      toast.success(message)
    } catch (error) {
      toast.error(error instanceof Error && error.message ? error.message : t('updateFailed'))
    }
  }

  async function postUpdate(data: IncidentUpdateDraft) {
    try {
      const { doc } = await statusPagesApi.incidents.postUpdate(orgId, pageId, incident.id, data)
      onSaved(doc)
      toast.success(
        data.status === 'resolved'
          ? t('resolved')
          : state.status === 'resolved'
            ? t('reopened')
            : t('composer.posted'),
      )
      return true
    } catch (error) {
      toast.error(error instanceof Error && error.message ? error.message : t('composer.failed'))
      return false
    }
  }

  async function editUpdate(updateId: string, message: string) {
    try {
      const { doc } = await statusPagesApi.incidents.editUpdate(
        orgId,
        pageId,
        incident.id,
        updateId,
        message,
      )
      onSaved(doc)
      toast.success(t('updateEdited'))
      return true
    } catch (error) {
      toast.error(error instanceof Error && error.message ? error.message : t('updateFailed'))
      return false
    }
  }

  const impacted = state.components.filter((c) => c.impact !== 'operational')

  return (
    <li
      data-incident-id={incident.id}
      className="flex flex-col gap-3 rounded-xl border bg-card px-4 py-3"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{incident.title}</span>
            <Badge variant="outline">{labels.status(state.status)}</Badge>
            {state.active && (
              <Badge className={cn('text-foreground', impactBadge[state.impact])}>
                {labels.impact(state.impact)}
              </Badge>
            )}
            {incident.pinned && <Badge variant="outline">{t('pinnedBadge')}</Badge>}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {t('openedAt', { time: formatTime(updates[0]?.postedAt ?? incident.createdAt) })}
            {state.resolvedAt && t('resolvedAt', { time: formatTime(state.resolvedAt) })}
          </p>
          {state.active && impacted.length > 0 && (
            <ul className="mt-2 flex flex-wrap gap-1" aria-label={t('components.title')}>
              {impacted.map((c) => (
                <li key={c.component}>
                  <Badge className={cn('text-foreground', impactBadge[c.impact])}>
                    {nameOf(c.component)}: {labels.impact(c.impact)}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-expanded={expanded}
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded ? <ChevronUp /> : <ChevronDown />}
            {expanded ? t('hideTimeline') : t('showTimeline', { count: updates.length })}
          </Button>
          {canEdit && (
            <>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={t('rename')}
                onClick={() => onRename(incident)}
              >
                <Pencil />
              </Button>
              {state.active && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={incident.pinned ? t('unpin') : t('pin')}
                  onClick={() =>
                    patch(
                      { pinned: !incident.pinned },
                      incident.pinned ? t('unpinned') : t('pinned'),
                    )
                  }
                >
                  {incident.pinned ? <PinOff /> : <Pin />}
                </Button>
              )}
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={t('delete')}
                onClick={() => onRemove(incident)}
              >
                <Trash2 />
              </Button>
            </>
          )}
        </div>
      </div>

      {expanded && (
        <div className="flex flex-col gap-4">
          {canEdit && (
            <UpdateComposer
              key={`${state.status}|${state.components.map((c) => `${c.component}:${c.impact}`).join(',')}`}
              incident={incident}
              options={options}
              onPost={postUpdate}
            />
          )}
          <section aria-label={t('timeline')}>
            <ol className="flex flex-col">
              {newestFirst.map((update, index) => (
                <TimelineEntry
                  key={update.id ?? index}
                  update={update}
                  options={options}
                  canEdit={canEdit}
                  timeZone={timeZone}
                  onEdit={(message) => editUpdate(String(update.id ?? 'legacy'), message)}
                />
              ))}
            </ol>
          </section>
        </div>
      )}
    </li>
  )
}

interface NewDraft {
  title: string
  status: IncidentStatus
  message: string
  impacts: ImpactMap
  impact: ComponentImpact
  pinned: boolean
}

const emptyDraft: NewDraft = {
  title: '',
  status: 'investigating',
  message: '',
  impacts: {},
  impact: 'degraded_performance',
  pinned: true,
}

export function IncidentsPanel({
  orgId,
  pageId,
  initialIncidents,
  components,
  canEdit,
  timeZone,
}: {
  orgId: OrgId
  pageId: OrgId
  initialIncidents: Incident[]
  /** Components of the page an incident can affect. */
  components: IncidentComponentOption[]
  canEdit: boolean
  /** Organization time zone the timestamps render in. */
  timeZone: string
}) {
  const t = useTranslations('statusPages.incidents')
  const [incidents, setIncidents] = React.useState(initialIncidents)
  const [creating, setCreating] = React.useState(false)
  const [draft, setDraft] = React.useState<NewDraft>(emptyDraft)
  const [renaming, setRenaming] = React.useState<Incident | null>(null)
  const [renameTitle, setRenameTitle] = React.useState('')
  const [pending, setPending] = React.useState(false)

  const upsert = (doc: Incident) =>
    setIncidents((list) => {
      const idx = list.findIndex((i) => String(i.id) === String(doc.id))
      if (idx < 0) return [doc, ...list]
      const next = list.slice()
      next[idx] = doc
      return next
    })

  async function create(event: React.FormEvent) {
    event.preventDefault()
    setPending(true)
    try {
      const componentless = Object.keys(draft.impacts).length === 0
      const { doc } = await statusPagesApi.incidents.create(orgId, pageId, {
        title: draft.title,
        pinned: draft.pinned,
        status: draft.status,
        message: draft.message,
        components: Object.entries(draft.impacts).map(([component, impact]) => ({
          component,
          impact,
        })),
        ...(componentless ? { impact: draft.impact } : {}),
      })
      upsert(doc)
      setCreating(false)
      toast.success(t('posted'))
    } catch (error) {
      toast.error(error instanceof Error && error.message ? error.message : t('saveFailed'))
    } finally {
      setPending(false)
    }
  }

  async function rename(event: React.FormEvent) {
    event.preventDefault()
    if (!renaming) return
    setPending(true)
    try {
      const { doc } = await statusPagesApi.incidents.update(orgId, pageId, renaming.id, {
        title: renameTitle,
      })
      upsert(doc)
      setRenaming(null)
      toast.success(t('renamed'))
    } catch (error) {
      toast.error(error instanceof Error && error.message ? error.message : t('saveFailed'))
    } finally {
      setPending(false)
    }
  }

  async function remove(incident: Incident) {
    if (!window.confirm(t('confirmDelete', { title: incident.title }))) return
    try {
      await statusPagesApi.incidents.remove(orgId, pageId, incident.id)
      setIncidents((list) => list.filter((i) => String(i.id) !== String(incident.id)))
      toast.success(t('deleted'))
    } catch (error) {
      toast.error(error instanceof Error && error.message ? error.message : t('deleteFailed'))
    }
  }

  const isActive = (incident: Incident) => incidentTimeline(incident).state.active
  const active = incidents.filter(isActive)
  const resolved = incidents.filter((incident) => !isActive(incident))

  const renderItem = (incident: Incident) => (
    <IncidentItem
      key={incident.id}
      incident={incident}
      options={components}
      canEdit={canEdit}
      timeZone={timeZone}
      orgId={orgId}
      pageId={pageId}
      onSaved={upsert}
      onRename={(i) => {
        setRenameTitle(i.title)
        setRenaming(i)
      }}
      onRemove={remove}
    />
  )

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <Label className="text-base">{t('title')}</Label>
          <p className="text-sm text-muted-foreground">{t('description')}</p>
        </div>
        <Button
          type="button"
          size="sm"
          disabled={!canEdit}
          onClick={() => {
            setDraft(emptyDraft)
            setCreating(true)
          }}
        >
          <Plus /> {t('post')}
        </Button>
      </div>

      {incidents.length === 0 ? (
        <p className="rounded-xl border border-dashed px-5 py-10 text-center text-sm text-muted-foreground">
          {t('empty')}
        </p>
      ) : (
        <>
          {active.length > 0 && <ul className="flex flex-col gap-2">{active.map(renderItem)}</ul>}
          {resolved.length > 0 && (
            <div className="flex flex-col gap-2">
              <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                {t('resolvedHeading')}
              </h3>
              <ul className="flex flex-col gap-2 opacity-90">{resolved.map(renderItem)}</ul>
            </div>
          )}
        </>
      )}

      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent className="max-h-[90vh] overflow-y-auto">
          <form onSubmit={create} className="flex flex-col gap-5">
            <DialogHeader>
              <DialogTitle>{t('newDialog.title')}</DialogTitle>
              <DialogDescription>{t('newDialog.description')}</DialogDescription>
            </DialogHeader>
            <div className="grid gap-2">
              <Label htmlFor="incident-title">{t('newDialog.titleLabel')}</Label>
              <Input
                id="incident-title"
                value={draft.title}
                required
                autoFocus
                onChange={(e) => setDraft({ ...draft, title: e.target.value })}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="incident-status">{t('composer.status')}</Label>
              <StatusSelect
                id="incident-status"
                value={draft.status}
                onChange={(status) => setDraft({ ...draft, status })}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="incident-message">{t('composer.message')}</Label>
              <Textarea
                id="incident-message"
                rows={4}
                value={draft.message}
                placeholder={t('composer.messagePlaceholder')}
                onChange={(e) => setDraft({ ...draft, message: e.target.value })}
              />
            </div>
            <div className="grid gap-2">
              <Label>{t('components.title')}</Label>
              <ComponentImpactEditor
                idPrefix="incident-new"
                options={components}
                value={draft.impacts}
                onChange={(impacts) => setDraft({ ...draft, impacts })}
              />
              {Object.keys(draft.impacts).length === 0 && (
                <div className="grid gap-1.5 pt-1">
                  <Label htmlFor="incident-impact">{t('components.overallImpact')}</Label>
                  <ImpactSelect
                    id="incident-impact"
                    value={draft.impact}
                    onChange={(impact) => setDraft({ ...draft, impact })}
                  />
                  <p className="text-xs text-muted-foreground">
                    {t('components.overallImpactHint')}
                  </p>
                </div>
              )}
            </div>
            <div className="flex items-center justify-between gap-3">
              <Label htmlFor="incident-pinned">{t('newDialog.pinToTop')}</Label>
              <Switch
                id="incident-pinned"
                checked={draft.pinned}
                onCheckedChange={(pinned) => setDraft({ ...draft, pinned })}
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setCreating(false)}>
                {t('newDialog.cancel')}
              </Button>
              <Button type="submit" disabled={pending || !draft.title.trim()}>
                {pending ? t('newDialog.saving') : t('newDialog.submit')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={renaming !== null} onOpenChange={(open) => !open && setRenaming(null)}>
        <DialogContent>
          <form onSubmit={rename} className="flex flex-col gap-5">
            <DialogHeader>
              <DialogTitle>{t('renameDialog.title')}</DialogTitle>
            </DialogHeader>
            <div className="grid gap-2">
              <Label htmlFor="incident-rename">{t('renameDialog.titleLabel')}</Label>
              <Input
                id="incident-rename"
                value={renameTitle}
                required
                autoFocus
                onChange={(e) => setRenameTitle(e.target.value)}
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setRenaming(null)}>
                {t('renameDialog.cancel')}
              </Button>
              <Button type="submit" disabled={pending || !renameTitle.trim()}>
                {t('renameDialog.save')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}
