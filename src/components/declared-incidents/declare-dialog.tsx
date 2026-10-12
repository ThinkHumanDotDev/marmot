'use client'

import { Siren } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import * as React from 'react'
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
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import {
  DECLARED_INCIDENT_SEVERITIES,
  type DeclaredIncidentSeverity,
} from '@/lib/declared-incidents'

import { declaredApi, errorMessage } from './api'

export interface MemberChoice {
  id: string
  name: string
}

const NOBODY = '__nobody__'

/** "Declare incident" button and its form; opens the new incident once it is declared. */
export function DeclareDialog({
  orgId,
  orgSlug,
  members,
}: {
  orgId: string | number
  orgSlug: string
  members: MemberChoice[]
}) {
  const t = useTranslations('declaredIncidents.declare')
  const ts = useTranslations('declaredIncidents.severity')
  const router = useRouter()
  const [open, setOpen] = React.useState(false)
  const [pending, setPending] = React.useState(false)
  const [title, setTitle] = React.useState('')
  const [severity, setSeverity] = React.useState<DeclaredIncidentSeverity>('major')
  const [commander, setCommander] = React.useState(NOBODY)
  const [summary, setSummary] = React.useState('')
  const [startedAt, setStartedAt] = React.useState('')
  const id = React.useId()

  const reset = () => {
    setTitle('')
    setSeverity('major')
    setCommander(NOBODY)
    setSummary('')
    setStartedAt('')
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setPending(true)
    try {
      const incident = await declaredApi.declare(orgId, {
        title: title.trim(),
        severity,
        summary: summary.trim() || undefined,
        commander: commander === NOBODY ? null : commander,
        // `datetime-local` is local wall time; Date turns it into an instant.
        startedAt: startedAt ? new Date(startedAt).toISOString() : undefined,
      })
      toast.success(t('declared'))
      setOpen(false)
      reset()
      router.push(`/${orgSlug}/declared-incidents/${incident.id}`)
    } catch (error) {
      toast.error(errorMessage(error, t('declared')))
    } finally {
      setPending(false)
    }
  }

  return (
    <>
      <Button onClick={() => setOpen(true)} data-testid="declare-incident">
        <Siren /> {t('title')}
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
                placeholder={t('namePlaceholder')}
                onChange={(event) => setTitle(event.target.value)}
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="grid gap-2">
                <Label htmlFor={`${id}-severity`}>{t('severity')}</Label>
                <Select
                  value={severity}
                  onValueChange={(value) => setSeverity(value as DeclaredIncidentSeverity)}
                >
                  <SelectTrigger id={`${id}-severity`} className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {DECLARED_INCIDENT_SEVERITIES.map((value) => (
                      <SelectItem key={value} value={value}>
                        {ts(value)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-2">
                <Label htmlFor={`${id}-commander`}>{t('commander')}</Label>
                <Select value={commander} onValueChange={setCommander}>
                  <SelectTrigger id={`${id}-commander`} className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NOBODY}>{t('noCommander')}</SelectItem>
                    {members.map((member) => (
                      <SelectItem key={member.id} value={member.id}>
                        {member.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid gap-2">
              <Label htmlFor={`${id}-summary`}>{t('summary')}</Label>
              <Textarea
                id={`${id}-summary`}
                value={summary}
                maxLength={5000}
                placeholder={t('summaryPlaceholder')}
                onChange={(event) => setSummary(event.target.value)}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor={`${id}-started`}>{t('startedAt')}</Label>
              <Input
                id={`${id}-started`}
                type="datetime-local"
                value={startedAt}
                onChange={(event) => setStartedAt(event.target.value)}
              />
              <p className="text-xs text-muted-foreground">{t('startedAtHint')}</p>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                {t('cancel')}
              </Button>
              <Button type="submit" disabled={pending || !title.trim()}>
                {t('submit')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  )
}
