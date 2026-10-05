'use client'

import { useRouter } from 'next/navigation'
import * as React from 'react'
import { toast } from 'sonner'

import { ImageUpload } from '@/components/image-upload'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { OrgSummary } from '@/lib/org'
import { orgApi } from '@/lib/org-api'

import { SlugField, useSlugAvailability } from './slug-field'
import { TimezoneSelect } from './timezone-select'

interface OrganizationFormProps {
  org: OrgSummary
  canEdit: boolean
}

/** Name, slug, logo and time zone. Saves through Payload REST so `organization:update` applies. */
export function OrganizationForm({ org, canEdit }: OrganizationFormProps) {
  const router = useRouter()
  const [name, setName] = React.useState(org.name)
  const [slug, setSlug] = React.useState(org.slug)
  const [timezone, setTimezone] = React.useState(org.timezone)
  const [pending, setPending] = React.useState(false)
  const slugStatus = useSlugAvailability(slug, org.slug)
  const ids = { name: React.useId(), slug: React.useId(), tz: React.useId() }

  const dirty = name.trim() !== org.name || slug.trim() !== org.slug || timezone !== org.timezone
  const slugOk = slugStatus.state === 'current' || slugStatus.state === 'available'
  const canSave = canEdit && dirty && name.trim().length > 0 && slugOk && !pending

  async function save(event: React.FormEvent) {
    event.preventDefault()
    if (!canSave) return
    setPending(true)
    try {
      const nextSlug = slug.trim().toLowerCase()
      await orgApi.update(org.id, {
        name: name.trim(),
        slug: nextSlug,
        settings: { timezone, weekStart: org.weekStart },
      })
      toast.success('Organization updated')
      if (nextSlug !== org.slug) {
        router.replace(`/${nextSlug}/settings/organization`)
      }
      router.refresh()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not save the organization.')
    } finally {
      setPending(false)
    }
  }

  async function setLogo(media: { id: string | number } | null) {
    try {
      await orgApi.update(org.id, { logo: media ? media.id : null })
      toast.success(media ? 'Logo updated' : 'Logo removed')
      router.refresh()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not update the logo.')
    }
  }

  return (
    <Card>
      <form onSubmit={save}>
        <CardHeader>
          <CardTitle>Organization</CardTitle>
          <CardDescription>
            {canEdit
              ? 'How this organization appears across Marmot.'
              : 'Only admins and owners can change these settings.'}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-6 pt-6">
          <div className="grid gap-2">
            <Label>Logo</Label>
            <ImageUpload
              value={org.logoUrl}
              label={org.name}
              onChange={setLogo}
              disabled={!canEdit}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor={ids.name}>Name</Label>
            <Input
              id={ids.name}
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={!canEdit}
              maxLength={120}
              required
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor={ids.slug}>Slug</Label>
            <SlugField
              id={ids.slug}
              value={slug}
              onChange={setSlug}
              status={slugStatus}
              disabled={!canEdit}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor={ids.tz}>Time zone</Label>
            <TimezoneSelect
              id={ids.tz}
              value={timezone}
              onChange={setTimezone}
              disabled={!canEdit}
            />
            <p className="text-xs text-muted-foreground">
              Used for maintenance windows, reports and status page times.
            </p>
          </div>
        </CardContent>
        {canEdit && (
          <CardFooter className="justify-end border-t pt-6">
            <Button type="submit" disabled={!canSave}>
              {pending ? 'Saving…' : 'Save changes'}
            </Button>
          </CardFooter>
        )}
      </form>
    </Card>
  )
}
