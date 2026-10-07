'use client'

import { ImageIcon, Trash2 } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import * as React from 'react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { defaultLocale, hasMultipleLocales, localeNames, locales } from '@/i18n/locales'
import type { StatusPage } from '@/payload-types'

import { statusPagesApi, type OrgId, type StatusPagePatch } from '../api'

type Values = Required<
  Pick<
    StatusPagePatch,
    | 'title'
    | 'slug'
    | 'description'
    | 'theme'
    | 'language'
    | 'searchEngineIndex'
    | 'showTags'
    | 'showCertificateExpiry'
    | 'showPoweredBy'
    | 'autoRefreshInterval'
    | 'footerText'
    | 'customCSS'
    | 'googleAnalyticsId'
  >
>

const fromPage = (page: StatusPage): Values => ({
  title: page.title,
  slug: page.slug,
  description: page.description ?? '',
  theme: page.theme ?? 'auto',
  language: page.language ?? defaultLocale,
  searchEngineIndex: Boolean(page.searchEngineIndex),
  showTags: Boolean(page.showTags),
  showCertificateExpiry: Boolean(page.showCertificateExpiry),
  showPoweredBy: page.showPoweredBy !== false,
  autoRefreshInterval: page.autoRefreshInterval ?? 300,
  footerText: page.footerText ?? '',
  customCSS: page.customCSS ?? '',
  googleAnalyticsId: page.googleAnalyticsId ?? '',
})

function Toggle({
  id,
  label,
  description,
  checked,
  onChange,
  disabled,
}: {
  id: string
  label: string
  description?: string
  checked: boolean
  onChange: (next: boolean) => void
  disabled?: boolean
}) {
  return (
    <div className="flex items-start justify-between gap-4 py-2">
      <div className="space-y-0.5">
        <Label htmlFor={id}>{label}</Label>
        {description && <p className="text-xs text-muted-foreground">{description}</p>}
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onChange} disabled={disabled} />
    </div>
  )
}

export function SettingsForm({
  orgId,
  orgSlug,
  page,
  onSaved,
  canEdit,
  canDelete,
}: {
  orgId: OrgId
  orgSlug: string
  page: StatusPage
  onSaved: (page: StatusPage) => void
  canEdit: boolean
  canDelete: boolean
}) {
  const t = useTranslations('statusPages.editor')
  const ts = useTranslations('statusPages.settings')
  const router = useRouter()
  const [values, setValues] = React.useState<Values>(() => fromPage(page))
  const [saving, setSaving] = React.useState(false)
  const [uploading, setUploading] = React.useState(false)
  const fileInput = React.useRef<HTMLInputElement>(null)

  const set = <K extends keyof Values>(key: K, value: Values[K]) =>
    setValues((v) => ({ ...v, [key]: value }))

  const dirty = JSON.stringify(values) !== JSON.stringify(fromPage(page))
  const logoUrl = page.logo && typeof page.logo === 'object' ? page.logo.url : null

  async function save(event: React.FormEvent) {
    event.preventDefault()
    setSaving(true)
    try {
      const { doc } = await statusPagesApi.update(orgId, page.id, {
        ...values,
        description: values.description || null,
        footerText: values.footerText || null,
        customCSS: values.customCSS || null,
        googleAnalyticsId: values.googleAnalyticsId || null,
      })
      onSaved(doc)
      setValues(fromPage(doc))
      toast.success(ts('saved'))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : ts('saveFailed'))
    } finally {
      setSaving(false)
    }
  }

  async function uploadLogo(file: File | undefined) {
    if (!file) return
    setUploading(true)
    try {
      onSaved(await statusPagesApi.uploadLogo(orgId, page.id, file))
      toast.success(ts('logo.updated'))
    } catch (error) {
      toast.error(error instanceof Error && error.message ? error.message : ts('logo.uploadFailed'))
    } finally {
      setUploading(false)
      if (fileInput.current) fileInput.current.value = ''
    }
  }

  async function removeLogo() {
    setUploading(true)
    try {
      const { doc } = await statusPagesApi.removeLogo(orgId, page.id)
      onSaved(doc)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : ts('logo.removeFailed'))
    } finally {
      setUploading(false)
    }
  }

  async function remove() {
    if (!window.confirm(ts('danger.confirm', { title: page.title }))) return
    try {
      await statusPagesApi.remove(orgId, page.id)
      toast.success(ts('danger.deleted'))
      router.push(`/${orgSlug}/status-pages`)
      router.refresh()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : ts('danger.failed'))
    }
  }

  return (
    <form onSubmit={save} className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
      <div className="flex flex-col gap-6">
        <Card>
          <CardHeader>
            <CardTitle>{ts('general.title')}</CardTitle>
            <CardDescription>{ts('general.description')}</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor="title">{ts('title')}</Label>
              <Input
                id="title"
                value={values.title}
                required
                disabled={!canEdit}
                onChange={(e) => set('title', e.target.value)}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="slug">{ts('slug')}</Label>
              <div className="flex items-center gap-2">
                <span className="shrink-0 text-sm text-muted-foreground">/status/</span>
                <Input
                  id="slug"
                  value={values.slug}
                  required
                  disabled={!canEdit}
                  pattern="[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?"
                  onChange={(e) => set('slug', e.target.value.toLowerCase())}
                />
              </div>
              <p className="text-xs text-muted-foreground">{ts('slugHint')}</p>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="description">{ts('description')}</Label>
              <Textarea
                id="description"
                rows={3}
                value={values.description ?? ''}
                disabled={!canEdit}
                onChange={(e) => set('description', e.target.value)}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="footerText">{ts('footerText')}</Label>
              <Textarea
                id="footerText"
                rows={2}
                value={values.footerText ?? ''}
                disabled={!canEdit}
                placeholder={ts('footerTextPlaceholder')}
                onChange={(e) => set('footerText', e.target.value)}
              />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{ts('appearance.title')}</CardTitle>
            <CardDescription>{ts('appearance.description')}</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="grid gap-2">
                <Label htmlFor="theme">{ts('theme')}</Label>
                <Select
                  value={values.theme ?? 'auto'}
                  disabled={!canEdit}
                  onValueChange={(v) => set('theme', v as Values['theme'])}
                >
                  <SelectTrigger id="theme">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="auto">{ts('themes.auto')}</SelectItem>
                    <SelectItem value="light">{ts('themes.light')}</SelectItem>
                    <SelectItem value="dark">{ts('themes.dark')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {hasMultipleLocales() && (
                <div className="grid gap-2">
                  <Label htmlFor="language">{t('language')}</Label>
                  <Select
                    value={values.language ?? defaultLocale}
                    disabled={!canEdit}
                    onValueChange={(v) => set('language', v as Values['language'])}
                  >
                    <SelectTrigger id="language">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="auto">{t('languageAuto')}</SelectItem>
                      {locales.map((locale) => (
                        <SelectItem key={locale} value={locale} lang={locale}>
                          {localeNames[locale]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
              <div className="grid gap-2">
                <Label htmlFor="autoRefreshInterval">{ts('autoRefresh')}</Label>
                <Input
                  id="autoRefreshInterval"
                  type="number"
                  min={0}
                  step={5}
                  disabled={!canEdit}
                  value={values.autoRefreshInterval ?? 0}
                  onChange={(e) => set('autoRefreshInterval', Math.max(0, Number(e.target.value)))}
                />
              </div>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="customCSS">{ts('customCss')}</Label>
              <Textarea
                id="customCSS"
                rows={6}
                spellCheck={false}
                className="font-mono text-xs"
                value={values.customCSS ?? ''}
                disabled={!canEdit}
                placeholder={'#status-page h1 { letter-spacing: -0.02em; }'}
                onChange={(e) => set('customCSS', e.target.value)}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="googleAnalyticsId">{ts('googleAnalytics')}</Label>
              <Input
                id="googleAnalyticsId"
                placeholder="G-XXXXXXXXXX"
                value={values.googleAnalyticsId ?? ''}
                disabled={!canEdit}
                onChange={(e) => set('googleAnalyticsId', e.target.value.trim())}
              />
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="flex flex-col gap-6">
        <Card>
          <CardHeader>
            <CardTitle>{ts('logo.title')}</CardTitle>
          </CardHeader>
          <CardContent className="flex items-center gap-4">
            {logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element -- arbitrary upload size
              <img
                src={logoUrl}
                alt=""
                className="size-14 rounded-lg border object-contain"
                width={56}
                height={56}
              />
            ) : (
              <span className="flex size-14 items-center justify-center rounded-lg border border-dashed text-muted-foreground">
                <ImageIcon className="size-5" aria-hidden />
              </span>
            )}
            <div className="flex flex-col gap-2">
              <input
                ref={fileInput}
                type="file"
                accept="image/*"
                className="sr-only"
                id="logo-file"
                disabled={!canEdit || uploading}
                onChange={(e) => void uploadLogo(e.target.files?.[0])}
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!canEdit || uploading}
                onClick={() => fileInput.current?.click()}
              >
                {uploading
                  ? ts('logo.uploading')
                  : logoUrl
                    ? ts('logo.replace')
                    : ts('logo.upload')}
              </Button>
              {logoUrl && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={!canEdit || uploading}
                  onClick={removeLogo}
                >
                  {ts('logo.remove')}
                </Button>
              )}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{ts('visibility.title')}</CardTitle>
          </CardHeader>
          <CardContent className="divide-y">
            <Toggle
              id="searchEngineIndex"
              label={ts('visibility.searchEngineIndex')}
              description={ts('visibility.searchEngineIndexHint')}
              checked={Boolean(values.searchEngineIndex)}
              disabled={!canEdit}
              onChange={(v) => set('searchEngineIndex', v)}
            />
            <Toggle
              id="showTags"
              label={ts('visibility.showTags')}
              description={ts('visibility.showTagsHint')}
              checked={Boolean(values.showTags)}
              disabled={!canEdit}
              onChange={(v) => set('showTags', v)}
            />
            <Toggle
              id="showCertificateExpiry"
              label={ts('visibility.showCertificateExpiry')}
              checked={Boolean(values.showCertificateExpiry)}
              disabled={!canEdit}
              onChange={(v) => set('showCertificateExpiry', v)}
            />
            <Toggle
              id="showPoweredBy"
              label={ts('visibility.showPoweredBy')}
              checked={Boolean(values.showPoweredBy)}
              disabled={!canEdit}
              onChange={(v) => set('showPoweredBy', v)}
            />
          </CardContent>
        </Card>

        <div className="flex items-center justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            disabled={!dirty || saving}
            onClick={() => setValues(fromPage(page))}
          >
            {ts('reset')}
          </Button>
          <Button type="submit" disabled={!canEdit || !dirty || saving}>
            {saving ? ts('saving') : ts('save')}
          </Button>
        </div>

        {canDelete && (
          <Card className="border-destructive/40">
            <CardHeader>
              <CardTitle className="text-destructive">{ts('danger.title')}</CardTitle>
              <CardDescription>{ts('danger.description')}</CardDescription>
            </CardHeader>
            <CardContent>
              <Button type="button" variant="destructive" size="sm" onClick={remove}>
                <Trash2 /> {ts('danger.delete')}
              </Button>
            </CardContent>
          </Card>
        )}
      </div>
    </form>
  )
}
