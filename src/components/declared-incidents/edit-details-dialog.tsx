'use client'

import { Pencil } from 'lucide-react'
import { useTranslations } from 'next-intl'
import * as React from 'react'

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
import { Textarea } from '@/components/ui/textarea'
import type { DeclaredIncidentSummary } from '@/lib/declared-incidents'
import type { UpdateDeclaredIncidentInput } from '@/lib/validation/declared-incident'

/** `datetime-local` value of an instant in the browser's zone. */
function toLocalInput(iso: string): string {
  const date = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * "Edit details": the title, summary and start of an incident that is not closed yet. Only the
 * fields that changed are sent, so the timeline records exactly those.
 */
export function EditDetailsDialog({
  incident,
  pending,
  onSave,
}: {
  incident: DeclaredIncidentSummary
  pending: boolean
  onSave: (body: UpdateDeclaredIncidentInput) => Promise<boolean>
}) {
  const t = useTranslations('declaredIncidents.edit')
  const id = React.useId()
  const [open, setOpen] = React.useState(false)
  const [title, setTitle] = React.useState(incident.title)
  const [summary, setSummary] = React.useState(incident.summary ?? '')
  const [startedAt, setStartedAt] = React.useState('')

  const show = () => {
    setTitle(incident.title)
    setSummary(incident.summary ?? '')
    setStartedAt(toLocalInput(incident.startedAt))
    setOpen(true)
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    const body: UpdateDeclaredIncidentInput = {}
    if (title.trim() !== incident.title) body.title = title.trim()
    if (summary.trim() !== (incident.summary ?? '')) body.summary = summary.trim() || null
    // `datetime-local` has minute precision: only send the start when the minute changed.
    if (startedAt && startedAt !== toLocalInput(incident.startedAt)) {
      body.startedAt = new Date(startedAt).toISOString()
    }
    if (Object.keys(body).length === 0 || (await onSave(body))) setOpen(false)
  }

  return (
    <>
      <Button variant="outline" size="sm" onClick={show} data-testid="declared-edit">
        <Pencil /> {t('open')}
      </Button>
      <Dialog open={open} onOpenChange={(next) => !pending && setOpen(next)}>
        <DialogContent>
          <form onSubmit={submit} className="grid gap-4">
            <DialogHeader>
              <DialogTitle>{t('title')}</DialogTitle>
              <DialogDescription>{t('description')}</DialogDescription>
            </DialogHeader>
            <div className="grid gap-2">
              <Label htmlFor={`${id}-title`}>{t('name')}</Label>
              <Input
                id={`${id}-title`}
                value={title}
                required
                maxLength={200}
                onChange={(event) => setTitle(event.target.value)}
                data-testid="declared-edit-title"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor={`${id}-summary`}>{t('summary')}</Label>
              <Textarea
                id={`${id}-summary`}
                value={summary}
                maxLength={5000}
                onChange={(event) => setSummary(event.target.value)}
                data-testid="declared-edit-summary"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor={`${id}-started`}>{t('startedAt')}</Label>
              <Input
                id={`${id}-started`}
                type="datetime-local"
                value={startedAt}
                required
                onChange={(event) => setStartedAt(event.target.value)}
                data-testid="declared-edit-started"
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                {t('cancel')}
              </Button>
              <Button
                type="submit"
                disabled={pending || !title.trim()}
                data-testid="declared-edit-save"
              >
                {t('save')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  )
}
