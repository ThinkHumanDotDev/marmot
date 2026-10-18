'use client'

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
import { Textarea } from '@/components/ui/textarea'
import { statusPageBaseUrl } from '@/lib/status-page-badge'
import {
  DEFAULT_EMBED_SNIPPET_OPTIONS,
  DEFAULT_WIDGET_SNIPPET_OPTIONS,
  EMBED_MODES,
  EMBED_SECTIONS,
  iframeSnippet,
  widgetSnippets,
  type EmbedMode,
  type EmbedSnippetOptions,
  type WidgetSnippetOptions,
} from '@/lib/status-page-embed'
import type { StatusPage } from '@/payload-types'

import { statusPagesApi, type OrgId } from '../api'
import { CopyField, SnippetLocaleSelect, useOrigin, useSnippetLocale } from './share-panel'

const originsToText = (page: StatusPage) =>
  (page.embedOrigins ?? []).map((row) => row.origin).join('\n')

const lines = (text: string) =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)

/** Who may frame the page (`allowEmbedding` + `embedOrigins`, #109). */
function EmbeddingSettings({
  orgId,
  page,
  onSaved,
  canEdit,
}: {
  orgId: OrgId
  page: StatusPage
  onSaved: (page: StatusPage) => void
  canEdit: boolean
}) {
  const t = useTranslations('statusPages.embed')
  const saved: EmbedMode = page.allowEmbedding ?? 'off'
  const [mode, setMode] = React.useState<EmbedMode>(saved)
  const [origins, setOrigins] = React.useState(() => originsToText(page))
  const [saving, setSaving] = React.useState(false)

  const isPublic = (page.access ?? 'public') === 'public'
  const missingOrigins = mode === 'origins' && lines(origins).length === 0
  const dirty =
    mode !== saved || (mode === 'origins' && origins.trim() !== originsToText(page).trim())
  const canSave = canEdit && dirty && !saving && !missingOrigins

  async function save(event: React.FormEvent) {
    event.preventDefault()
    if (!canSave) return
    setSaving(true)
    try {
      const { doc } = await statusPagesApi.update(orgId, page.id, {
        allowEmbedding: mode,
        ...(mode === 'origins'
          ? { embedOrigins: lines(origins).map((origin) => ({ origin })) }
          : {}),
      })
      onSaved(doc)
      setMode(doc.allowEmbedding ?? 'off')
      setOrigins(originsToText(doc))
      toast.success(t('saved'))
    } catch (error) {
      toast.error(error instanceof Error && error.message ? error.message : t('saveFailed'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={save} className="grid gap-4" data-testid="embed-settings">
      {!isPublic && (
        <p className="rounded-lg border border-dashed px-4 py-2 text-xs text-muted-foreground">
          {t('protectedNotice')}
        </p>
      )}
      <div className="grid gap-2 sm:max-w-sm">
        <Label htmlFor="embed-mode">{t('mode')}</Label>
        <Select value={mode} onValueChange={(v) => setMode(v as EmbedMode)} disabled={!canEdit}>
          <SelectTrigger id="embed-mode" aria-describedby="embed-mode-hint">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {EMBED_MODES.map((value) => (
              <SelectItem key={value} value={value}>
                {t(`modes.${value}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p id="embed-mode-hint" className="text-xs text-muted-foreground">
          {t(`modeHints.${mode}`)}
        </p>
      </div>
      {mode === 'origins' && (
        <div className="grid gap-2">
          <Label htmlFor="embed-origins">{t('origins')}</Label>
          <Textarea
            id="embed-origins"
            rows={4}
            spellCheck={false}
            className="font-mono text-xs"
            placeholder={'https://docs.example.com\nhttps://*.example.com'}
            value={origins}
            disabled={!canEdit}
            onChange={(e) => setOrigins(e.target.value)}
            aria-describedby="embed-origins-hint"
          />
          <p id="embed-origins-hint" className="text-xs text-muted-foreground">
            {t('originsHint')}
          </p>
        </div>
      )}
      {canEdit && (
        <div className="flex justify-end">
          <Button type="submit" disabled={!canSave}>
            {saving ? t('saving') : t('save')}
          </Button>
        </div>
      )}
    </form>
  )
}

/** Live preview of the widget: loads the page's own `widget.js` like a host site would. */
function WidgetPreview({ src, options }: { src: string; options: WidgetSnippetOptions }) {
  const ref = React.useRef<HTMLSpanElement>(null)
  React.useEffect(() => {
    const host = ref.current
    if (!host) return
    const script = document.createElement('script')
    script.src = src
    script.async = true
    script.dataset.theme = options.theme
    script.dataset.size = options.size
    host.appendChild(script)
    return () => host.replaceChildren()
  }, [src, options.theme, options.size])
  return <span ref={ref} data-testid="status-widget-preview" />
}

/**
 * "Share" tab, second half (#109): who may embed the page, the iframe snippet of the embed mode and
 * the status widget's HTML and React snippets.
 */
export function EmbedPanel({
  orgId,
  page,
  onSaved,
  canEdit,
}: {
  orgId: OrgId
  page: StatusPage
  onSaved: (page: StatusPage) => void
  canEdit: boolean
}) {
  const t = useTranslations('statusPages.embed')
  const origin = useOrigin()
  const [embed, setEmbed] = React.useState<EmbedSnippetOptions>(DEFAULT_EMBED_SNIPPET_OPTIONS)
  const [widget, setWidget] = React.useState<WidgetSnippetOptions>(DEFAULT_WIDGET_SNIPPET_OPTIONS)
  // The iframe and the widget open the page in their own language (#271).
  const embedLocale = useSnippetLocale(page)
  const widgetLocale = useSnippetLocale(page)
  const baseUrl = statusPageBaseUrl(origin, page.slug)
  const iframe = iframeSnippet(`${baseUrl}${embedLocale.prefix}`, page.title, embed)
  const widgetPageUrl = `${baseUrl}${widgetLocale.prefix}`
  const snippets = widgetSnippets(widgetPageUrl, widget)
  const live = Boolean(page.published) && (page.access ?? 'public') === 'public'

  const toggleSection = (section: (typeof EMBED_SECTIONS)[number], on: boolean) =>
    setEmbed((current) => ({
      ...current,
      sections: on
        ? EMBED_SECTIONS.filter((s) => s === section || current.sections.includes(s))
        : current.sections.filter((s) => s !== section),
    }))

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>{t('title')}</CardTitle>
          <CardDescription>{t('description')}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-6">
          <EmbeddingSettings
            key={`${page.allowEmbedding}-${originsToText(page)}`}
            orgId={orgId}
            page={page}
            onSaved={onSaved}
            canEdit={canEdit}
          />

          <fieldset className="grid gap-2">
            <legend className="mb-2 text-sm font-medium">{t('sections')}</legend>
            <div className="flex flex-wrap gap-4">
              {EMBED_SECTIONS.map((section) => (
                <label key={section} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="accent-primary"
                    checked={embed.sections.includes(section)}
                    disabled={embed.sections.length === 1 && embed.sections.includes(section)}
                    onChange={(e) => toggleSection(section, e.target.checked)}
                  />
                  {t(`sectionNames.${section}`)}
                </label>
              ))}
            </div>
          </fieldset>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="embed-theme">{t('theme')}</Label>
              <Select
                value={embed.theme}
                onValueChange={(v) =>
                  setEmbed((c) => ({ ...c, theme: v as EmbedSnippetOptions['theme'] }))
                }
              >
                <SelectTrigger id="embed-theme">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="page">{t('themes.page')}</SelectItem>
                  <SelectItem value="light">{t('themes.light')}</SelectItem>
                  <SelectItem value="dark">{t('themes.dark')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="embed-height">{t('height')}</Label>
              <Input
                id="embed-height"
                type="number"
                min={100}
                max={4000}
                step={50}
                value={embed.height}
                onChange={(e) => setEmbed((c) => ({ ...c, height: Number(e.target.value) }))}
              />
            </div>
            <SnippetLocaleSelect
              id="embed-locale"
              locale={embedLocale.locale}
              offered={embedLocale.offered}
              onChange={embedLocale.setLocale}
            />
          </div>
          <CopyField id="embed-iframe" label={t('iframe')} value={iframe} rows={3} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('widget.title')}</CardTitle>
          <CardDescription>{t('widget.description')}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-6">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="widget-theme">{t('theme')}</Label>
              <Select
                value={widget.theme}
                onValueChange={(v) =>
                  setWidget((c) => ({ ...c, theme: v as WidgetSnippetOptions['theme'] }))
                }
              >
                <SelectTrigger id="widget-theme">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="light">{t('themes.light')}</SelectItem>
                  <SelectItem value="dark">{t('themes.dark')}</SelectItem>
                  <SelectItem value="auto">{t('themes.auto')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="widget-size">{t('widget.size')}</Label>
              <Select
                value={widget.size}
                onValueChange={(v) =>
                  setWidget((c) => ({ ...c, size: v as WidgetSnippetOptions['size'] }))
                }
              >
                <SelectTrigger id="widget-size">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="sm">{t('widget.sizes.sm')}</SelectItem>
                  <SelectItem value="md">{t('widget.sizes.md')}</SelectItem>
                  <SelectItem value="lg">{t('widget.sizes.lg')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <SnippetLocaleSelect
              id="widget-locale"
              locale={widgetLocale.locale}
              offered={widgetLocale.offered}
              onChange={widgetLocale.setLocale}
            />
          </div>
          <div className="grid gap-2">
            <span className="text-sm font-medium">{t('widget.preview')}</span>
            <div className="flex min-h-16 items-center rounded-lg border px-4 py-3">
              {live && origin ? (
                <WidgetPreview src={`${widgetPageUrl}/widget.js`} options={widget} />
              ) : (
                <span className="text-xs text-muted-foreground">{t('widget.unavailable')}</span>
              )}
            </div>
          </div>
          <CopyField id="widget-html" label={t('widget.html')} value={snippets.widgetHtml} />
          <CopyField
            id="widget-react"
            label={t('widget.react')}
            value={snippets.widgetReact}
            rows={8}
          />
        </CardContent>
      </Card>
    </>
  )
}
