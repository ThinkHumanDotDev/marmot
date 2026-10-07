'use client'

import { Plus } from 'lucide-react'
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
  DialogTrigger,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { ApiError } from '@/lib/api'

import { slugify, statusPagesApi, type OrgId } from './api'

export function CreateStatusPageDialog({
  orgId,
  orgSlug,
  canCreate = true,
}: {
  orgId: OrgId
  orgSlug: string
  canCreate?: boolean
}) {
  const t = useTranslations('statusPages.create')
  const router = useRouter()
  const [open, setOpen] = React.useState(false)
  const [title, setTitle] = React.useState('')
  const [slug, setSlug] = React.useState('')
  const [slugTouched, setSlugTouched] = React.useState(false)
  const [description, setDescription] = React.useState('')
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const reset = () => {
    setTitle('')
    setSlug('')
    setSlugTouched(false)
    setDescription('')
    setError(null)
  }

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault()
    setPending(true)
    setError(null)
    try {
      const { doc } = await statusPagesApi.create(orgId, {
        title: title.trim(),
        slug: slug.trim(),
        description: description.trim() || undefined,
      })
      toast.success(t('created'))
      setOpen(false)
      reset()
      router.push(`/${orgSlug}/status-pages/${doc.id}`)
      router.refresh()
    } catch (err) {
      setError(err instanceof ApiError || err instanceof Error ? err.message : t('failed'))
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) reset()
      }}
    >
      <DialogTrigger asChild>
        <Button disabled={!canCreate}>
          <Plus /> {t('trigger')}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <form onSubmit={onSubmit} className="flex flex-col gap-5">
          <DialogHeader>
            <DialogTitle>{t('title')}</DialogTitle>
            <DialogDescription>{t('description')}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Label htmlFor="sp-title">{t('titleLabel')}</Label>
            <Input
              id="sp-title"
              value={title}
              autoFocus
              required
              onChange={(e) => {
                setTitle(e.target.value)
                if (!slugTouched) setSlug(slugify(e.target.value))
              }}
              placeholder={t('titlePlaceholder')}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="sp-slug">{t('slugLabel')}</Label>
            <div className="flex items-center gap-2">
              <span className="shrink-0 text-sm text-muted-foreground">/status/</span>
              <Input
                id="sp-slug"
                value={slug}
                required
                pattern="[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?"
                onChange={(e) => {
                  setSlugTouched(true)
                  setSlug(e.target.value.toLowerCase())
                }}
                placeholder="acme"
              />
            </div>
            <p className="text-xs text-muted-foreground">{t('slugHint')}</p>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="sp-description">{t('descriptionLabel')}</Label>
            <Textarea
              id="sp-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t('descriptionPlaceholder')}
              rows={2}
            />
          </div>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              {t('cancel')}
            </Button>
            <Button type="submit" disabled={pending || !title.trim() || !slug.trim()}>
              {pending ? t('submitting') : t('submit')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
