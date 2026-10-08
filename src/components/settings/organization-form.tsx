'use client'

import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
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
  const t = useTranslations('settings.organization.form')
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
      toast.success(t('saved'))
      if (nextSlug !== org.slug) {
        router.replace(`/${nextSlug}/settings/organization`)
      }
      router.refresh()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('saveFailed'))
    } finally {
      setPending(false)
    }
  }

  async function uploadLogo(file: File) {
    await orgApi.uploadLogo(org.id, file)
    toast.success(t('logoUpdated'))
    router.refresh()
  }

  async function removeLogo() {
    try {
      await orgApi.removeLogo(org.id)
      toast.success(t('logoRemoved'))
      router.refresh()
    } catch (error) {
      toast.error(error instanceof Error && error.message ? error.message : t('logoFailed'))
    }
  }

  return (
    <Card>
      <form onSubmit={save}>
        <CardHeader>
          <CardTitle>{t('title')}</CardTitle>
          <CardDescription>{canEdit ? t('description') : t('readOnly')}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-6 pt-6">
          <div className="grid gap-2">
            <Label>{t('logo')}</Label>
            <ImageUpload
              value={org.logoUrl}
              label={org.name}
              onUpload={uploadLogo}
              onRemove={removeLogo}
              disabled={!canEdit}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor={ids.name}>{t('name')}</Label>
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
            <Label htmlFor={ids.slug}>{t('slug')}</Label>
            <SlugField
              id={ids.slug}
              value={slug}
              onChange={setSlug}
              status={slugStatus}
              disabled={!canEdit}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor={ids.tz}>{t('timezone')}</Label>
            <TimezoneSelect
              id={ids.tz}
              value={timezone}
              onChange={setTimezone}
              disabled={!canEdit}
            />
            <p className="text-xs text-muted-foreground">{t('timezoneHint')}</p>
          </div>
        </CardContent>
        {canEdit && (
          <CardFooter className="justify-end border-t pt-6">
            <Button type="submit" disabled={!canSave}>
              {pending ? t('saving') : t('save')}
            </Button>
          </CardFooter>
        )}
      </form>
    </Card>
  )
}
