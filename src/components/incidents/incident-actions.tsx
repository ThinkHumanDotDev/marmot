'use client'

import { CheckCircle2, Eye, Megaphone } from 'lucide-react'
import { useTranslations } from 'next-intl'
import * as React from 'react'
import { toast } from 'sonner'

import { ConfirmDialog } from '@/components/confirm-dialog'
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
import { Textarea } from '@/components/ui/textarea'
import type { MonitorIncidentSummary } from '@/lib/monitor-incidents'

import { incidentsApi } from './api'

export interface StatusPageChoice {
  id: string
  title: string
}

interface IncidentActionsProps {
  orgId: string | number
  incident: MonitorIncidentSummary
  canAcknowledge: boolean
  canResolve: boolean
  /** `status-page:update`; the publish button also needs at least one status page. */
  canPublish: boolean
  statusPages: StatusPageChoice[]
  onChange: (incident: MonitorIncidentSummary) => void
  size?: 'sm' | 'default'
}

const message = (error: unknown, fallback: string) =>
  error instanceof Error && error.message ? error.message : fallback

function NoteField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const t = useTranslations('incidents.actions')
  const id = React.useId()
  return (
    <div className="grid gap-2">
      <Label htmlFor={id}>{t('note')}</Label>
      <Textarea
        id={id}
        value={value}
        maxLength={2000}
        placeholder={t('notePlaceholder')}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  )
}

/** Acknowledge / Resolve / Publish buttons of an incident, each confirmed in a dialog. */
export function IncidentActions({
  orgId,
  incident,
  canAcknowledge,
  canResolve,
  canPublish,
  statusPages,
  onChange,
  size = 'default',
}: IncidentActionsProps) {
  const t = useTranslations('incidents.actions')
  const [dialog, setDialog] = React.useState<'acknowledge' | 'resolve' | 'publish' | null>(null)
  const [note, setNote] = React.useState('')

  const open = (next: typeof dialog) => {
    setNote('')
    setDialog(next)
  }

  async function run(action: 'acknowledge' | 'resolve') {
    try {
      const updated =
        action === 'acknowledge'
          ? await incidentsApi.acknowledge(orgId, incident.id, note.trim() || undefined)
          : await incidentsApi.resolve(orgId, incident.id, note.trim() || undefined)
      onChange(updated)
      toast.success(action === 'acknowledge' ? t('acknowledged') : t('resolved'))
      setDialog(null)
    } catch (error) {
      toast.error(message(error, t('failed')))
    }
  }

  const showAck = canAcknowledge && incident.status === 'open'
  const showResolve = canResolve && incident.status !== 'resolved'
  const showPublish = canPublish && !incident.statusPageIncident && statusPages.length > 0
  if (!showAck && !showResolve && !showPublish) return null

  return (
    <div className="flex flex-wrap items-center gap-2">
      {showAck && (
        <Button size={size} onClick={() => open('acknowledge')} data-testid="incident-acknowledge">
          <Eye /> {t('acknowledge')}
        </Button>
      )}
      {showResolve && (
        <Button
          size={size}
          variant="outline"
          onClick={() => open('resolve')}
          data-testid="incident-resolve"
        >
          <CheckCircle2 /> {t('resolve')}
        </Button>
      )}
      {showPublish && (
        <Button size={size} variant="outline" onClick={() => open('publish')}>
          <Megaphone /> {t('publish')}
        </Button>
      )}

      <ConfirmDialog
        open={dialog === 'acknowledge'}
        onOpenChange={(next) => !next && setDialog(null)}
        title={t('acknowledgeTitle')}
        description={t('acknowledgeDescription')}
        confirmLabel={t('acknowledge')}
        onConfirm={() => run('acknowledge')}
      >
        <NoteField value={note} onChange={setNote} />
      </ConfirmDialog>
      <ConfirmDialog
        open={dialog === 'resolve'}
        onOpenChange={(next) => !next && setDialog(null)}
        title={t('resolveTitle')}
        description={t('resolveDescription')}
        confirmLabel={t('resolve')}
        onConfirm={() => run('resolve')}
      >
        <NoteField value={note} onChange={setNote} />
      </ConfirmDialog>
      {showPublish && (
        <PublishDialog
          open={dialog === 'publish'}
          onOpenChange={(next) => !next && setDialog(null)}
          orgId={orgId}
          incident={incident}
          statusPages={statusPages}
          onPublished={(updated) => {
            onChange(updated)
            setDialog(null)
          }}
        />
      )}
    </div>
  )
}

function PublishDialog({
  open,
  onOpenChange,
  orgId,
  incident,
  statusPages,
  onPublished,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  orgId: string | number
  incident: MonitorIncidentSummary
  statusPages: StatusPageChoice[]
  onPublished: (incident: MonitorIncidentSummary) => void
}) {
  const t = useTranslations('incidents.publish')
  const ta = useTranslations('incidents.actions')
  const [pageId, setPageId] = React.useState(statusPages.length === 1 ? statusPages[0].id : '')
  const [title, setTitle] = React.useState(incident.monitor?.name ?? '')
  const [body, setBody] = React.useState('')
  const [pending, setPending] = React.useState(false)
  const ids = { page: React.useId(), title: React.useId(), message: React.useId() }

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (!pageId) return
    setPending(true)
    try {
      const result = await incidentsApi.publish(orgId, incident.id, {
        statusPageId: pageId,
        title: title.trim() || undefined,
        message: body.trim() || undefined,
      })
      toast.success(t('published'))
      onPublished(result.incident)
    } catch (error) {
      toast.error(message(error, t('failed')))
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <DialogContent>
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{t('title')}</DialogTitle>
            <DialogDescription>{t('description')}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor={ids.page}>{t('statusPage')}</Label>
            <Select value={pageId} onValueChange={setPageId}>
              <SelectTrigger id={ids.page} className="w-full">
                <SelectValue placeholder={t('chooseStatusPage')} />
              </SelectTrigger>
              <SelectContent>
                {statusPages.map((page) => (
                  <SelectItem key={page.id} value={page.id}>
                    {page.title}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-2">
            <Label htmlFor={ids.title}>{t('incidentTitle')}</Label>
            <Input
              id={ids.title}
              value={title}
              maxLength={200}
              onChange={(event) => setTitle(event.target.value)}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor={ids.message}>{t('message')}</Label>
            <Textarea
              id={ids.message}
              value={body}
              placeholder={t('messagePlaceholder')}
              onChange={(event) => setBody(event.target.value)}
            />
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={() => onOpenChange(false)}
            >
              {ta('cancel')}
            </Button>
            <Button type="submit" disabled={pending || !pageId}>
              {pending ? ta('working') : t('submit')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
