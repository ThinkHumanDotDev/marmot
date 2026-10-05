'use client'

import { Plus } from 'lucide-react'
import { useRouter } from 'next/navigation'
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
      toast.success('Status page created')
      setOpen(false)
      reset()
      router.push(`/${orgSlug}/status-pages/${doc.id}`)
      router.refresh()
    } catch (err) {
      setError(err instanceof ApiError || err instanceof Error ? err.message : 'Could not create')
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
          <Plus /> New status page
        </Button>
      </DialogTrigger>
      <DialogContent>
        <form onSubmit={onSubmit} className="flex flex-col gap-5">
          <DialogHeader>
            <DialogTitle>New status page</DialogTitle>
            <DialogDescription>
              Pages start unpublished. Add monitors and publish when it looks right.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Label htmlFor="sp-title">Title</Label>
            <Input
              id="sp-title"
              value={title}
              autoFocus
              required
              onChange={(e) => {
                setTitle(e.target.value)
                if (!slugTouched) setSlug(slugify(e.target.value))
              }}
              placeholder="Acme status"
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="sp-slug">Slug</Label>
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
            <p className="text-xs text-muted-foreground">
              Lowercase letters, numbers and hyphens. Globally unique.
            </p>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="sp-description">Description (optional)</Label>
            <Textarea
              id="sp-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Live status of our services."
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
              Cancel
            </Button>
            <Button type="submit" disabled={pending || !title.trim() || !slug.trim()}>
              {pending ? 'Creating…' : 'Create'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
