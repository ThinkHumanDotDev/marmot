'use client'

import { ExternalLink, Pencil, Trash2 } from 'lucide-react'
import { useFormatter, useTranslations } from 'next-intl'
import * as React from 'react'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { MAX_ACTION_ITEMS, type DeclaredActionItem } from '@/lib/declared-incidents'
import type { ActionItemInput } from '@/lib/validation/declared-incident'
import { cn } from '@/lib/utils'

import type { MemberChoice } from './declare-dialog'

const NOBODY = '__nobody__'

const toInput = (item: DeclaredActionItem): ActionItemInput => ({
  id: item.id,
  title: item.title,
  owner: item.owner?.id ?? null,
  dueDate: item.dueDate,
  done: item.done,
  ticketUrl: item.ticketUrl,
})

interface Draft {
  /** The item being edited; `null` adds a new one. */
  id: string | null
  title: string
  owner: string
  dueDate: string
  ticketUrl: string
}

const emptyDraft = (): Draft => ({ id: null, title: '', owner: NOBODY, dueDate: '', ticketUrl: '' })

/**
 * The postmortem's action items (#285): structured follow-ups with an owner, a due date, a done
 * flag and the ticket tracking them. Every change saves the whole list.
 */
export function ActionItems({
  items,
  members,
  editable,
  pending,
  onSave,
}: {
  items: DeclaredActionItem[]
  members: MemberChoice[]
  editable: boolean
  pending: boolean
  onSave: (items: ActionItemInput[], success: string) => Promise<boolean>
}) {
  const t = useTranslations('declaredIncidents.actionItems')
  const format = useFormatter()
  const id = React.useId()
  const [draft, setDraft] = React.useState<Draft>(emptyDraft)

  const toggle = (item: DeclaredActionItem) =>
    void onSave(
      items.map((row) =>
        row.id === item.id ? { ...toInput(row), done: !row.done } : toInput(row),
      ),
      item.done ? t('reopened') : t('completed'),
    )

  const remove = (item: DeclaredActionItem) =>
    void onSave(items.filter((row) => row.id !== item.id).map(toInput), t('removed'))

  const edit = (item: DeclaredActionItem) =>
    setDraft({
      id: item.id,
      title: item.title,
      owner: item.owner?.id ?? NOBODY,
      dueDate: item.dueDate ?? '',
      ticketUrl: item.ticketUrl ?? '',
    })

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (!draft.title.trim()) return
    const fields = {
      title: draft.title.trim(),
      owner: draft.owner === NOBODY ? null : draft.owner,
      dueDate: draft.dueDate || null,
      ticketUrl: draft.ticketUrl.trim() || null,
    }
    const next = draft.id
      ? items.map((row) => (row.id === draft.id ? { ...toInput(row), ...fields } : toInput(row)))
      : [...items.map(toInput), { ...fields, done: false }]
    if (await onSave(next, draft.id ? t('updated') : t('added'))) setDraft(emptyDraft())
  }

  const due = (value: string) => format.dateTime(new Date(`${value}T00:00:00Z`), 'utcDate')

  return (
    <Card className="gap-3" data-testid="declared-action-items">
      <CardHeader>
        <CardTitle className="text-base">{t('title')}</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4">
        {items.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('empty')}</p>
        ) : (
          <ul className="grid gap-2" data-testid="action-item-list">
            {items.map((item) => (
              <li
                key={item.id}
                className="flex items-start gap-3 rounded-lg border px-3 py-2"
                data-testid="action-item"
                data-done={item.done}
              >
                <input
                  type="checkbox"
                  className="mt-1 size-4 accent-primary"
                  checked={item.done}
                  disabled={!editable || pending}
                  onChange={() => toggle(item)}
                  aria-label={t('done', { title: item.title })}
                />
                <div className="grid min-w-0 flex-1 gap-0.5">
                  <span
                    className={cn(
                      'text-sm font-medium break-words',
                      item.done && 'text-muted-foreground line-through',
                    )}
                  >
                    {item.title}
                  </span>
                  <span className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
                    <span>{item.owner ? t('owner', { name: item.owner.name }) : t('noOwner')}</span>
                    {item.dueDate && <span>{t('due', { date: due(item.dueDate) })}</span>}
                    {item.ticketUrl && /^https?:\/\//i.test(item.ticketUrl) && (
                      <a
                        href={item.ticketUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-primary hover:underline"
                      >
                        {t('ticket')} <ExternalLink className="size-3" aria-hidden />
                      </a>
                    )}
                  </span>
                </div>
                {editable && (
                  <div className="flex shrink-0 gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-7"
                      disabled={pending}
                      onClick={() => edit(item)}
                      aria-label={t('edit', { title: item.title })}
                    >
                      <Pencil className="size-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-7"
                      disabled={pending}
                      onClick={() => remove(item)}
                      aria-label={t('remove', { title: item.title })}
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}

        {editable && (draft.id !== null || items.length < MAX_ACTION_ITEMS) && (
          <form onSubmit={submit} className="grid gap-3 rounded-lg border border-dashed p-3">
            <div className="grid gap-1.5">
              <Label htmlFor={`${id}-title`}>{draft.id ? t('editing') : t('new')}</Label>
              <Input
                id={`${id}-title`}
                value={draft.title}
                maxLength={500}
                placeholder={t('placeholder')}
                onChange={(event) => setDraft({ ...draft, title: event.target.value })}
                data-testid="action-item-title"
              />
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="grid gap-1.5">
                <Label htmlFor={`${id}-owner`}>{t('ownerLabel')}</Label>
                <Select
                  value={draft.owner}
                  onValueChange={(value) => setDraft({ ...draft, owner: value })}
                >
                  <SelectTrigger id={`${id}-owner`} className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NOBODY}>{t('noOwner')}</SelectItem>
                    {members.map((member) => (
                      <SelectItem key={member.id} value={member.id}>
                        {member.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor={`${id}-due`}>{t('dueLabel')}</Label>
                <Input
                  id={`${id}-due`}
                  type="date"
                  value={draft.dueDate}
                  onChange={(event) => setDraft({ ...draft, dueDate: event.target.value })}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor={`${id}-ticket`}>{t('ticketLabel')}</Label>
                <Input
                  id={`${id}-ticket`}
                  type="url"
                  value={draft.ticketUrl}
                  placeholder="https://"
                  maxLength={2000}
                  onChange={(event) => setDraft({ ...draft, ticketUrl: event.target.value })}
                />
              </div>
            </div>
            <div className="flex justify-end gap-2">
              {draft.id && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setDraft(emptyDraft())}
                >
                  {t('cancel')}
                </Button>
              )}
              <Button
                type="submit"
                size="sm"
                disabled={pending || !draft.title.trim()}
                data-testid="action-item-submit"
              >
                {draft.id ? t('save') : t('add')}
              </Button>
            </div>
          </form>
        )}
      </CardContent>
    </Card>
  )
}
