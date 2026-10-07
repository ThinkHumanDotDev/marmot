'use client'

import { Check, Loader2, Pencil, Plus, Tag as TagIcon, Trash2 } from 'lucide-react'
import { useLocale, useTranslations } from 'next-intl'
import * as React from 'react'
import { toast } from 'sonner'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { EmptyState } from '@/components/empty-state'
import { TagChip } from '@/components/monitors/tag-chip'
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
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { TAG_COLOR_PATTERN, TAG_COLORS } from '@/lib/monitor-resources'
import { cn } from '@/lib/utils'

import { tagsApi, type TagRow } from './resources-api'

interface TagsSettingsProps {
  orgId: string
  initial: TagRow[]
  /** `tag:update` — create, edit and delete. */
  canManage: boolean
}

const byName = (locale: string) => (a: TagRow, b: TagRow) => a.name.localeCompare(b.name, locale)

export function TagsSettings({ orgId, initial, canManage }: TagsSettingsProps) {
  const t = useTranslations('settings.tags')
  const locale = useLocale()
  const [rows, setRows] = React.useState<TagRow[]>(() => [...initial].sort(byName(locale)))
  const [editing, setEditing] = React.useState<TagRow | 'new' | null>(null)
  const [deleting, setDeleting] = React.useState<TagRow | null>(null)

  const upsert = (row: TagRow) =>
    setRows((current) =>
      (current.some((r) => r.id === row.id)
        ? current.map((r) => (r.id === row.id ? row : r))
        : [...current, row]
      ).sort(byName(locale)),
    )

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <div className="space-y-1.5">
          <CardTitle>{t('title')}</CardTitle>
          <CardDescription>
            {t.rich('description', { code: (chunks) => <code>{chunks}</code> })}
          </CardDescription>
        </div>
        {canManage && (
          <Button size="sm" onClick={() => setEditing('new')} data-testid="tag-new">
            <Plus /> {t('new')}
          </Button>
        )}
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <EmptyState icon={TagIcon} title={t('emptyTitle')} description={t('emptyDescription')} />
        ) : (
          <ul className="divide-y rounded-lg border">
            {rows.map((row) => (
              <li key={row.id} className="flex items-center justify-between gap-3 px-3 py-2">
                <TagChip tag={row} className="text-xs" />
                <span className="flex-1 font-mono text-xs text-muted-foreground">{row.color}</span>
                {canManage && (
                  <span className="flex gap-1">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t('editLabel', { name: row.name })}
                      onClick={() => setEditing(row)}
                    >
                      <Pencil />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t('deleteLabel', { name: row.name })}
                      onClick={() => setDeleting(row)}
                    >
                      <Trash2 />
                    </Button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>

      {canManage && (
        <TagDialog
          orgId={orgId}
          tag={editing === 'new' ? null : editing}
          open={editing !== null}
          onOpenChange={(open) => !open && setEditing(null)}
          onSaved={(row) => {
            upsert(row)
            setEditing(null)
          }}
        />
      )}

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={t('confirmDeleteTitle', { name: deleting?.name ?? '' })}
        description={t('confirmDeleteDescription')}
        confirmLabel={t('confirmDelete')}
        destructive
        onConfirm={async () => {
          if (!deleting) return
          try {
            await tagsApi.remove(deleting.id)
            setRows((current) => current.filter((r) => r.id !== deleting.id))
            toast.success(t('deleted'))
            setDeleting(null)
          } catch (error) {
            toast.error(error instanceof Error ? error.message : t('deleteFailed'))
          }
        }}
      />
    </Card>
  )
}

/** Radix unmounts the content when closed, so the form starts from `tag` on every open. */
function TagDialog({ open, ...props }: React.ComponentProps<typeof TagForm> & { open: boolean }) {
  return (
    <Dialog open={open} onOpenChange={props.onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <TagForm {...props} />
      </DialogContent>
    </Dialog>
  )
}

function TagForm({
  orgId,
  tag,
  onOpenChange,
  onSaved,
}: {
  orgId: string
  tag: TagRow | null
  onOpenChange: (open: boolean) => void
  onSaved: (row: TagRow) => void
}) {
  const t = useTranslations('settings.tags.form')
  const tc = useTranslations('settings.tags.colors')
  const [name, setName] = React.useState(tag?.name ?? '')
  const [color, setColor] = React.useState<string>(tag?.color ?? TAG_COLORS[0].value)
  const [saving, setSaving] = React.useState(false)

  const colorValid = TAG_COLOR_PATTERN.test(color)
  const canSave = name.trim().length > 0 && colorValid && !saving

  async function save(event: React.FormEvent) {
    event.preventDefault()
    if (!canSave) return
    setSaving(true)
    try {
      const data = { name: name.trim(), color }
      const row = tag ? await tagsApi.update(tag.id, data) : await tagsApi.create(orgId, data)
      toast.success(tag ? t('saved') : t('created'))
      onSaved(row)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('failed'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <form onSubmit={save} className="grid gap-5">
        <DialogHeader>
          <DialogTitle>{tag ? t('editTitle') : t('newTitle')}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-2">
          <Label htmlFor="tag-name">{t('name')}</Label>
          <Input
            id="tag-name"
            value={name}
            maxLength={100}
            autoComplete="off"
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="tag-color">{t('colour')}</Label>
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={t('colour')}>
            {TAG_COLORS.map((option) => (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={color.toLowerCase() === option.value.toLowerCase()}
                aria-label={tc(option.key)}
                title={tc(option.key)}
                onClick={() => setColor(option.value)}
                className="grid size-7 place-items-center rounded-full ring-offset-2 ring-offset-background outline-none focus-visible:ring-2 focus-visible:ring-ring"
                style={{ backgroundColor: option.value }}
              >
                {color.toLowerCase() === option.value.toLowerCase() && (
                  <Check className="size-4 text-white" aria-hidden />
                )}
              </button>
            ))}
          </div>
          <Input
            id="tag-color"
            value={color}
            onChange={(e) => setColor(e.target.value.trim())}
            className={cn('font-mono', !colorValid && 'border-destructive')}
            aria-invalid={!colorValid}
          />
          <TagChip tag={{ name: name.trim() || t('preview'), color: colorValid ? color : null }} />
        </div>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            {t('cancel')}
          </Button>
          <Button type="submit" disabled={!canSave}>
            {saving && <Loader2 className="animate-spin" />}
            {tag ? t('save') : t('create')}
          </Button>
        </DialogFooter>
      </form>
    </>
  )
}
