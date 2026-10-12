'use client'

import { Trash2 } from 'lucide-react'
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
import { defaultLocale, localeNames, locales, type Locale } from '@/i18n/locales'
import {
  DEFAULT_MAINTENANCE_VISIBILITY_HOURS,
  MAX_MAINTENANCE_VISIBILITY_HOURS,
} from '@/lib/maintenance-announcements'
import { DEFAULT_PAST_INCIDENTS_DAYS, MAX_PAST_INCIDENTS_DAYS } from '@/lib/status-page-events'
import {
  DEFAULT_UPTIME_CALCULATION_MODE,
  UPTIME_BAR_DAY_OPTIONS,
  UPTIME_CALCULATION_MODES,
  isUptimeCalculationMode,
  uptimeBarDaysOf,
  type UptimeCalculationMode,
} from '@/lib/uptime-history'
import type { StatusPage } from '@/payload-types'

import { statusPagesApi, type OrgId, type StatusPagePatch } from '../api'

type Values = Required<
  Pick<
    StatusPagePatch,
    | 'title'
    | 'slug'
    | 'description'
    | 'homepageUrl'
    | 'contactUrl'
    | 'defaultLocale'
    | 'additionalLocales'
    | 'timeZoneMode'
    | 'timeZone'
    | 'searchEngineIndex'
    | 'showTags'
    | 'showCertificateExpiry'
    | 'showPoweredBy'
    | 'showValues'
    | 'uptimeBarDays'
    | 'uptimeCalculation'
    | 'showUptimePercentage'
    | 'autoRefreshInterval'
    | 'maintenanceVisibilityHours'
    | 'pastIncidentsDays'
    | 'footerText'
    | 'customCSS'
    | 'googleAnalyticsId'
  >
>

const fromPage = (page: StatusPage): Values => ({
  title: page.title,
  slug: page.slug,
  description: page.description ?? '',
  homepageUrl: page.homepageUrl ?? '',
  contactUrl: page.contactUrl ?? '',
  defaultLocale: page.defaultLocale ?? defaultLocale,
  additionalLocales: page.additionalLocales ?? [],
  timeZoneMode: page.timeZoneMode ?? 'visitor',
  timeZone: page.timeZone ?? '',
  searchEngineIndex: Boolean(page.searchEngineIndex),
  showTags: Boolean(page.showTags),
  showCertificateExpiry: Boolean(page.showCertificateExpiry),
  showPoweredBy: page.showPoweredBy !== false,
  showValues: page.showValues !== false,
  uptimeBarDays: uptimeBarDaysOf(page.uptimeBarDays),
  uptimeCalculation: isUptimeCalculationMode(page.uptimeCalculation)
    ? page.uptimeCalculation
    : DEFAULT_UPTIME_CALCULATION_MODE,
  showUptimePercentage: page.showUptimePercentage !== false,
  autoRefreshInterval: page.autoRefreshInterval ?? 300,
  maintenanceVisibilityHours:
    page.maintenanceVisibilityHours ?? DEFAULT_MAINTENANCE_VISIBILITY_HOURS,
  pastIncidentsDays: page.pastIncidentsDays ?? DEFAULT_PAST_INCIDENTS_DAYS,
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
  const tl = useTranslations('statusPages.settings.localization')
  const ts = useTranslations('statusPages.settings')
  const tm = useTranslations('maintenance.announcements')
  const router = useRouter()
  const [values, setValues] = React.useState<Values>(() => fromPage(page))
  const [saving, setSaving] = React.useState(false)

  const set = <K extends keyof Values>(key: K, value: Values[K]) =>
    setValues((v) => ({ ...v, [key]: value }))

  const dirty = JSON.stringify(values) !== JSON.stringify(fromPage(page))

  async function save(event: React.FormEvent) {
    event.preventDefault()
    setSaving(true)
    try {
      const { doc } = await statusPagesApi.update(orgId, page.id, {
        ...values,
        description: values.description || null,
        homepageUrl: values.homepageUrl?.trim() || null,
        contactUrl: values.contactUrl?.trim() || null,
        footerText: values.footerText || null,
        customCSS: values.customCSS || null,
        googleAnalyticsId: values.googleAnalyticsId || null,
        timeZone: values.timeZone?.trim() || null,
        additionalLocales: (values.additionalLocales ?? []).filter(
          (locale) => locale !== values.defaultLocale,
        ),
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
            <CardTitle>{ts('links.title')}</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <div className="grid content-start gap-2">
              <Label htmlFor="homepageUrl">{ts('links.homepageUrl')}</Label>
              <Input
                id="homepageUrl"
                type="url"
                placeholder="https://example.com"
                value={values.homepageUrl ?? ''}
                disabled={!canEdit}
                onChange={(e) => set('homepageUrl', e.target.value)}
              />
              <p className="text-xs text-muted-foreground">{ts('links.homepageUrlHint')}</p>
            </div>
            <div className="grid content-start gap-2">
              <Label htmlFor="contactUrl">{ts('links.contactUrl')}</Label>
              <Input
                id="contactUrl"
                placeholder="mailto:support@example.com"
                value={values.contactUrl ?? ''}
                disabled={!canEdit}
                onChange={(e) => set('contactUrl', e.target.value)}
              />
              <p className="text-xs text-muted-foreground">{ts('links.contactUrlHint')}</p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{tl('title')}</CardTitle>
            <CardDescription>{tl('description')}</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="grid gap-2">
                <Label htmlFor="defaultLocale">{tl('defaultLocale')}</Label>
                <Select
                  value={values.defaultLocale ?? defaultLocale}
                  disabled={!canEdit}
                  onValueChange={(v) => set('defaultLocale', v as Locale)}
                >
                  <SelectTrigger id="defaultLocale">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {locales.map((locale) => (
                      <SelectItem key={locale} value={locale} lang={locale}>
                        {localeNames[locale]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">{tl('defaultLocaleHint')}</p>
              </div>
              <fieldset className="grid gap-2" data-offered-locales>
                <legend className="mb-2 text-sm leading-none font-medium">{tl('locales')}</legend>
                <div className="flex flex-wrap gap-x-4 gap-y-2">
                  {locales
                    .filter((locale) => locale !== values.defaultLocale)
                    .map((locale) => {
                      const id = `locale-${locale}`
                      const checked = (values.additionalLocales ?? []).includes(locale)
                      return (
                        <div key={locale} className="flex items-center gap-2">
                          <Switch
                            id={id}
                            checked={checked}
                            disabled={!canEdit}
                            onCheckedChange={(on) =>
                              set(
                                'additionalLocales',
                                on
                                  ? [...(values.additionalLocales ?? []), locale]
                                  : (values.additionalLocales ?? []).filter((l) => l !== locale),
                              )
                            }
                          />
                          <Label htmlFor={id} lang={locale}>
                            {localeNames[locale]}
                          </Label>
                        </div>
                      )
                    })}
                </div>
                <p className="text-xs text-muted-foreground">{tl('localesHint')}</p>
              </fieldset>
              <div className="grid gap-2">
                <Label htmlFor="timeZoneMode">{tl('timeZoneMode')}</Label>
                <Select
                  value={values.timeZoneMode ?? 'visitor'}
                  disabled={!canEdit}
                  onValueChange={(v) => set('timeZoneMode', v as 'visitor' | 'page')}
                >
                  <SelectTrigger id="timeZoneMode">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="visitor">{tl('timeZoneModes.visitor')}</SelectItem>
                    <SelectItem value="page">{tl('timeZoneModes.page')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="timeZone">{tl('timeZone')}</Label>
                <Input
                  id="timeZone"
                  placeholder={tl('timeZonePlaceholder')}
                  value={values.timeZone ?? ''}
                  disabled={!canEdit}
                  onChange={(e) => set('timeZone', e.target.value)}
                />
                <p className="text-xs text-muted-foreground">{tl('timeZoneHint')}</p>
              </div>
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
              <div className="grid gap-2">
                <Label htmlFor="maintenanceVisibilityHours">{tm('pageVisibility')}</Label>
                <div className="relative">
                  <Input
                    id="maintenanceVisibilityHours"
                    type="number"
                    min={0}
                    max={MAX_MAINTENANCE_VISIBILITY_HOURS}
                    step={1}
                    disabled={!canEdit}
                    className="pr-10"
                    aria-describedby="maintenanceVisibilityHoursHint"
                    value={
                      values.maintenanceVisibilityHours ?? DEFAULT_MAINTENANCE_VISIBILITY_HOURS
                    }
                    onChange={(e) =>
                      set(
                        'maintenanceVisibilityHours',
                        Math.min(
                          MAX_MAINTENANCE_VISIBILITY_HOURS,
                          Math.max(0, Math.floor(Number(e.target.value) || 0)),
                        ),
                      )
                    }
                  />
                  <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-muted-foreground">
                    {tm('hoursUnit')}
                  </span>
                </div>
                <p id="maintenanceVisibilityHoursHint" className="text-xs text-muted-foreground">
                  {tm('pageVisibilityHint')}
                </p>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="pastIncidentsDays">{ts('pastIncidentsDays')}</Label>
                <Input
                  id="pastIncidentsDays"
                  type="number"
                  min={0}
                  max={MAX_PAST_INCIDENTS_DAYS}
                  step={1}
                  disabled={!canEdit}
                  aria-describedby="pastIncidentsDaysHint"
                  value={values.pastIncidentsDays ?? DEFAULT_PAST_INCIDENTS_DAYS}
                  onChange={(e) =>
                    set(
                      'pastIncidentsDays',
                      Math.min(
                        MAX_PAST_INCIDENTS_DAYS,
                        Math.max(0, Math.floor(Number(e.target.value) || 0)),
                      ),
                    )
                  }
                />
                <p id="pastIncidentsDaysHint" className="text-xs text-muted-foreground">
                  {ts('pastIncidentsDaysHint')}
                </p>
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
            <CardTitle>{ts('uptime.title')}</CardTitle>
            <CardDescription>{ts('uptime.description')}</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor="uptimeBarDays">{ts('uptime.days')}</Label>
              <Select
                value={String(values.uptimeBarDays)}
                disabled={!canEdit}
                onValueChange={(v) => set('uptimeBarDays', uptimeBarDaysOf(Number(v)))}
              >
                <SelectTrigger id="uptimeBarDays">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {UPTIME_BAR_DAY_OPTIONS.map((days) => (
                    <SelectItem key={days} value={String(days)}>
                      {ts('uptime.daysOption', { days })}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="uptimeCalculation">{ts('uptime.calculation')}</Label>
              <Select
                value={values.uptimeCalculation ?? DEFAULT_UPTIME_CALCULATION_MODE}
                disabled={!canEdit}
                onValueChange={(v) => set('uptimeCalculation', v as UptimeCalculationMode)}
              >
                <SelectTrigger id="uptimeCalculation" aria-describedby="uptimeCalculationHint">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {UPTIME_CALCULATION_MODES.map((mode) => (
                    <SelectItem key={mode} value={mode}>
                      {ts(`uptime.modes.${mode}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p id="uptimeCalculationHint" className="text-xs text-muted-foreground">
                {ts(
                  `uptime.modeHints.${values.uptimeCalculation ?? DEFAULT_UPTIME_CALCULATION_MODE}`,
                )}
              </p>
            </div>
            <Toggle
              id="showUptimePercentage"
              label={ts('uptime.showPercentage')}
              description={ts('uptime.showPercentageHint')}
              checked={Boolean(values.showUptimePercentage)}
              disabled={!canEdit}
              onChange={(v) => set('showUptimePercentage', v)}
            />
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
              id="showValues"
              label={ts('visibility.showValues')}
              description={ts('visibility.showValuesHint')}
              checked={Boolean(values.showValues)}
              disabled={!canEdit}
              onChange={(v) => set('showValues', v)}
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
