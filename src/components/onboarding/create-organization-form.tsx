'use client'

import { useRouter } from 'next/navigation'
import * as React from 'react'
import { toast } from 'sonner'

import { SlugField, useSlugAvailability } from '@/components/settings/slug-field'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { orgApi } from '@/lib/org-api'
import { slugify } from '@/lib/slugify'

/** Name → auto slug (editable) with live availability; `POST /api/organizations` on submit. */
export function CreateOrganizationForm() {
  const router = useRouter()
  const [name, setName] = React.useState('')
  const [slug, setSlug] = React.useState('')
  const [slugTouched, setSlugTouched] = React.useState(false)
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const status = useSlugAvailability(slug)
  const ids = { name: React.useId(), slug: React.useId() }

  function onNameChange(value: string) {
    setName(value)
    if (!slugTouched) setSlug(slugify(value))
  }

  const canSubmit = name.trim().length > 0 && status.state === 'available' && !pending

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (!canSubmit) return
    setPending(true)
    setError(null)
    try {
      const { doc } = await orgApi.create({ name: name.trim(), slug: slug.trim().toLowerCase() })
      toast.success(`Welcome to ${name.trim()}`)
      router.replace(`/${doc.slug}`)
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the organization.')
      setPending(false)
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-5" noValidate>
      <div className="grid gap-2">
        <Label htmlFor={ids.name}>Organization name</Label>
        <Input
          id={ids.name}
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
          placeholder="Acme Inc."
          autoComplete="organization"
          autoFocus
          maxLength={120}
          required
        />
      </div>
      <div className="grid gap-2">
        <Label htmlFor={ids.slug}>URL slug</Label>
        <SlugField
          id={ids.slug}
          value={slug}
          onChange={(value) => {
            setSlugTouched(true)
            setSlug(value)
          }}
          status={status}
          placeholder="acme"
        />
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <Button type="submit" className="w-full" disabled={!canSubmit}>
        {pending ? 'Creating…' : 'Create organization'}
      </Button>
    </form>
  )
}
