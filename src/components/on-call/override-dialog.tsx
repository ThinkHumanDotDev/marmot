'use client'

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
import type { OnCallScheduleSummary } from '@/lib/on-call'

import { errorMessage, onCallApi, toLocalInput } from './api'
import type { Choice } from './schedule-dialog'

/** Stored overrides of a schedule as request bodies. */
export const overridesBody = (schedule: OnCallScheduleSummary) =>
  schedule.overrides.map((override) => ({
    user: override.user.id,
    start: override.start,
    end: override.end,
    note: override.note,
  }))

/** "Add override" button and form: one member on call for a time range. */
export function OverrideDialog({
  orgId,
  schedule,
  members,
}: {
  orgId: string | number
  schedule: OnCallScheduleSummary
  members: Choice[]
}) {
  const t = useTranslations('onCall.override')
  const router = useRouter()
  const id = React.useId()
  const [open, setOpen] = React.useState(false)
  const [pending, setPending] = React.useState(false)
  const [user, setUser] = React.useState('')
  const [start, setStart] = React.useState('')
  const [end, setEnd] = React.useState('')
  const [note, setNote] = React.useState('')

  const openDialog = () => {
    const now = new Date()
    now.setMinutes(0, 0, 0)
    setUser('')
    setStart(toLocalInput(now))
    setEnd(toLocalInput(new Date(now.getTime() + 24 * 3_600_000)))
    setNote('')
    setOpen(true)
  }

  const valid = Boolean(user && start && end && new Date(end) > new Date(start))

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (!valid) return
    setPending(true)
    try {
      await onCallApi.updateSchedule(orgId, schedule.id, {
        overrides: [
          ...overridesBody(schedule),
          {
            user,
            start: new Date(start).toISOString(),
            end: new Date(end).toISOString(),
            note: note.trim() || null,
          },
        ],
      })
      toast.success(t('saved'))
      setOpen(false)
      router.refresh()
    } catch (error) {
      toast.error(errorMessage(error, t('failed')))
    } finally {
      setPending(false)
    }
  }

  return (
    <>
      <Button type="button" variant="outline" size="sm" onClick={openDialog}>
        {t('add')}
      </Button>
      <Dialog open={open} onOpenChange={(next) => !pending && setOpen(next)}>
        <DialogContent>
          <form onSubmit={submit} className="flex flex-col gap-4">
            <DialogHeader>
              <DialogTitle>{t('title')}</DialogTitle>
              <DialogDescription>{t('description')}</DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-2">
              <Label htmlFor={`${id}-user`}>{t('user')}</Label>
              <Select value={user} onValueChange={setUser}>
                <SelectTrigger id={`${id}-user`} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {members.map((member) => (
                    <SelectItem key={member.id} value={member.id}>
                      {member.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="flex flex-col gap-2">
                <Label htmlFor={`${id}-start`}>{t('start')}</Label>
                <Input
                  id={`${id}-start`}
                  type="datetime-local"
                  value={start}
                  onChange={(event) => setStart(event.target.value)}
                  required
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor={`${id}-end`}>{t('end')}</Label>
                <Input
                  id={`${id}-end`}
                  type="datetime-local"
                  value={end}
                  onChange={(event) => setEnd(event.target.value)}
                  required
                />
              </div>
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor={`${id}-note`}>{t('note')}</Label>
              <Input
                id={`${id}-note`}
                value={note}
                maxLength={200}
                onChange={(event) => setNote(event.target.value)}
              />
            </div>
            <DialogFooter>
              <Button type="submit" disabled={pending || !valid}>
                {t('save')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  )
}
