'use client'

import { ImageIcon, RotateCcw } from 'lucide-react'
import { useFormatter, useTranslations } from 'next-intl'
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
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  contrastRatio,
  getThemePreset,
  isValidColor,
  isValidRadius,
  resolveThemeColors,
  THEME_COLOR_TOKENS,
  THEME_MODES,
  THEME_PRESETS,
  toHex,
  type ThemeColorToken,
  type ThemeMode,
  type ThemeOverrides,
} from '@/lib/status-page-themes'
import { cn } from '@/lib/utils'
import type { Media, StatusPage } from '@/payload-types'

import { statusPagesApi, type OrgId, type StatusPageAssetKind } from '../api'
import { ThemePreview } from './theme-preview'

const BANNER_MAX = 140

type ColorDraft = Record<ThemeColorToken, string>

interface Draft {
  theme: NonNullable<StatusPage['theme']>
  themePreset: string
  light: ColorDraft
  dark: ColorDraft
  radius: string
  bannerText: string
}

const TOKEN_GROUPS: { key: 'surfaces' | 'status' | 'charts'; tokens: ThemeColorToken[] }[] = [
  {
    key: 'surfaces',
    tokens: [
      'background',
      'foreground',
      'card',
      'primary',
      'primaryForeground',
      'muted',
      'mutedForeground',
      'border',
    ],
  },
  { key: 'status', tokens: ['success', 'warning', 'info', 'destructive'] },
  { key: 'charts', tokens: ['chart1', 'chart2', 'chart3', 'chart4', 'chart5'] },
]

const emptyColors = (): ColorDraft =>
  Object.fromEntries(THEME_COLOR_TOKENS.map((token) => [token, ''])) as ColorDraft

const fromPage = (page: StatusPage): Draft => {
  const overrides = (page.themeOverrides ?? {}) as ThemeOverrides
  return {
    theme: page.theme ?? 'auto',
    themePreset: getThemePreset(page.themePreset).id,
    light: { ...emptyColors(), ...overrides.light },
    dark: { ...emptyColors(), ...overrides.dark },
    radius: overrides.radius ?? '',
    bannerText: page.bannerText ?? '',
  }
}

/** Only the filled-in, valid values: what the preview and contrast checks use. */
function validOverrides(draft: Draft): ThemeOverrides {
  const pick = (colors: ColorDraft) =>
    Object.fromEntries(
      Object.entries(colors).filter(([, value]) => value.trim() && isValidColor(value)),
    )
  return {
    light: pick(draft.light),
    dark: pick(draft.dark),
    ...(draft.radius.trim() && isValidRadius(draft.radius.trim())
      ? { radius: draft.radius.trim() }
      : {}),
  }
}

/** The PATCH payload; the server normalises and validates again. */
function toPatch(draft: Draft) {
  const filled = (colors: ColorDraft) =>
    Object.fromEntries(
      Object.entries(colors)
        .map(([token, value]) => [token, value.trim()])
        .filter(([, value]) => value),
    )
  const light = filled(draft.light)
  const dark = filled(draft.dark)
  const radius = draft.radius.trim()
  const overrides = {
    ...(Object.keys(light).length ? { light } : {}),
    ...(Object.keys(dark).length ? { dark } : {}),
    ...(radius ? { radius } : {}),
  }
  return {
    theme: draft.theme,
    themePreset: draft.themePreset,
    themeOverrides: Object.keys(overrides).length ? overrides : null,
    bannerText: draft.bannerText.trim() || null,
  }
}

const mediaUrl = (value: StatusPage['logo']): string | null =>
  value && typeof value === 'object' ? ((value as Media).url ?? null) : null

function Swatches({ colors }: { colors: { [K in ThemeColorToken]: string } }) {
  return (
    <span
      className="flex h-6 overflow-hidden rounded-md border"
      style={{ background: colors.background }}
      aria-hidden
    >
      {(['primary', 'success', 'warning', 'info', 'destructive'] as const).map((token) => (
        <span key={token} className="m-1 flex-1 rounded-sm" style={{ background: colors[token] }} />
      ))}
    </span>
  )
}

const ASSET_LIMITS: Record<StatusPageAssetKind, number> = {
  logo: 2 * 1024 * 1024,
  logoDark: 2 * 1024 * 1024,
  favicon: 100 * 1024,
}
const ASSET_ACCEPT: Record<StatusPageAssetKind, string> = {
  logo: 'image/png,image/jpeg,image/gif,image/webp,image/avif,image/svg+xml',
  logoDark: 'image/png,image/jpeg,image/gif,image/webp,image/avif,image/svg+xml',
  favicon: 'image/png,image/x-icon,image/vnd.microsoft.icon,image/svg+xml,.ico',
}

function AssetField({
  kind,
  orgId,
  page,
  onSaved,
  canEdit,
}: {
  kind: StatusPageAssetKind
  orgId: OrgId
  page: StatusPage
  onSaved: (page: StatusPage) => void
  canEdit: boolean
}) {
  const t = useTranslations('statusPages.theme.branding')
  const format = useBytes()
  const [busy, setBusy] = React.useState(false)
  const input = React.useRef<HTMLInputElement>(null)
  const url = mediaUrl(page[kind])
  const label = t(kind)
  const id = `asset-${kind}`

  async function upload(file: File | undefined) {
    if (!file) return
    if (file.size > ASSET_LIMITS[kind]) {
      toast.error(t('tooLarge', { asset: label, size: format(ASSET_LIMITS[kind]) }))
      if (input.current) input.current.value = ''
      return
    }
    setBusy(true)
    try {
      onSaved(await statusPagesApi.uploadAsset(orgId, page.id, kind, file))
      toast.success(t('updated', { asset: label }))
    } catch (error) {
      toast.error(error instanceof Error && error.message ? error.message : t('uploadFailed'))
    } finally {
      setBusy(false)
      if (input.current) input.current.value = ''
    }
  }

  async function remove() {
    setBusy(true)
    try {
      const { doc } = await statusPagesApi.removeAsset(orgId, page.id, kind)
      onSaved(doc)
      toast.success(t('removed', { asset: label }))
    } catch (error) {
      toast.error(error instanceof Error && error.message ? error.message : t('removeFailed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex items-start gap-4 py-3" data-asset={kind}>
      <span
        className={cn(
          'flex size-14 shrink-0 items-center justify-center overflow-hidden rounded-lg border',
          // Preview the dark logo on a dark surface.
          kind === 'logoDark' ? 'bg-neutral-900' : 'bg-background',
          !url && 'border-dashed text-muted-foreground',
        )}
      >
        {url ? (
          // eslint-disable-next-line @next/next/no-img-element -- arbitrary upload size
          <img src={url} alt="" className="size-full object-contain" width={56} height={56} />
        ) : (
          <ImageIcon className="size-5" aria-hidden />
        )}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div>
          <Label htmlFor={id}>{label}</Label>
          <p className="text-xs text-muted-foreground">{t(`${kind}Hint`)}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <input
            ref={input}
            id={id}
            type="file"
            accept={ASSET_ACCEPT[kind]}
            className="sr-only"
            disabled={!canEdit || busy}
            onChange={(e) => void upload(e.target.files?.[0])}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!canEdit || busy}
            onClick={() => input.current?.click()}
          >
            {busy ? t('uploading') : url ? t('replace') : t('upload')}
          </Button>
          {url && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={!canEdit || busy}
              onClick={remove}
            >
              {t('remove')}
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}

/** `100 KB`, `2 MB` through the locale's number formatter. */
function useBytes() {
  const format = useFormatter()
  return React.useCallback(
    (bytes: number) => {
      const mb = bytes >= 1024 * 1024
      return format.number(mb ? bytes / (1024 * 1024) : bytes / 1024, {
        style: 'unit',
        unit: mb ? 'megabyte' : 'kilobyte',
        maximumFractionDigits: 0,
      })
    },
    [format],
  )
}

function ColorRow({
  token,
  mode,
  value,
  presetValue,
  disabled,
  onChange,
}: {
  token: ThemeColorToken
  mode: ThemeMode
  value: string
  presetValue: string
  disabled: boolean
  onChange: (value: string) => void
}) {
  const t = useTranslations('statusPages.theme')
  const id = `token-${mode}-${token}`
  const label = t(`tokens.${token}`)
  const invalid = value.trim() !== '' && !isValidColor(value)
  const effective = value.trim() && !invalid ? value : presetValue
  return (
    <div className="grid gap-1">
      <div className="grid grid-cols-[minmax(0,8.5rem)_auto_minmax(0,1fr)_auto] items-center gap-2">
        <Label htmlFor={id} className="truncate text-sm font-normal">
          {label}
        </Label>
        <input
          type="color"
          aria-label={t('overrides.picker', { token: label })}
          className="h-8 w-9 cursor-pointer rounded-md border bg-transparent p-0.5 disabled:cursor-not-allowed"
          value={toHex(effective) ?? '#000000'}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
        />
        <Input
          id={id}
          value={value}
          spellCheck={false}
          autoComplete="off"
          className="h-8 font-mono text-xs"
          placeholder={presetValue}
          aria-invalid={invalid || undefined}
          aria-describedby={invalid ? `${id}-error` : undefined}
          disabled={disabled}
          maxLength={64}
          onChange={(e) => onChange(e.target.value)}
        />
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          disabled={disabled || !value}
          onClick={() => onChange('')}
          title={t('overrides.reset', { token: label })}
        >
          <RotateCcw aria-hidden />
          <span className="sr-only">{t('overrides.reset', { token: label })}</span>
        </Button>
      </div>
      {invalid && (
        <p id={`${id}-error`} className="text-xs text-destructive">
          {t('overrides.invalid')}
        </p>
      )}
    </div>
  )
}

/** Text pairs that must stay readable, plus any status colour the admin overrode. */
function useContrastWarnings(draft: Draft, mode: ThemeMode) {
  const t = useTranslations('statusPages.theme')
  return React.useMemo(() => {
    const c = resolveThemeColors(draft.themePreset, validOverrides(draft), mode)
    const checks: { label: string; a: string; b: string; min: number }[] = [
      { label: t('contrast.pairs.text'), a: c.foreground, b: c.background, min: 4.5 },
      { label: t('contrast.pairs.card'), a: c.foreground, b: c.card, min: 4.5 },
      { label: t('contrast.pairs.muted'), a: c.mutedForeground, b: c.background, min: 4.5 },
      { label: t('contrast.pairs.primary'), a: c.primaryForeground, b: c.primary, min: 4.5 },
    ]
    for (const token of ['success', 'warning', 'info', 'destructive'] as const) {
      if (draft[mode][token].trim()) {
        checks.push({
          label: t('contrast.pairs.status', { status: t(`tokens.${token}`) }),
          a: c[token],
          b: c.background,
          min: 3,
        })
      }
    }
    return checks.flatMap((check) => {
      const ratio = contrastRatio(check.a, check.b)
      return ratio !== null && ratio < check.min ? [{ ...check, ratio }] : []
    })
  }, [draft, mode, t])
}

export function ThemeEditor({
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
  const t = useTranslations('statusPages.theme')
  const format = useFormatter()
  const [draft, setDraft] = React.useState<Draft>(() => fromPage(page))
  const [mode, setMode] = React.useState<ThemeMode>(page.theme === 'dark' ? 'dark' : 'light')
  const [saving, setSaving] = React.useState(false)
  const warnings = useContrastWarnings(draft, mode)

  const saved = React.useMemo(() => fromPage(page), [page])
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved)
  const preset = getThemePreset(draft.themePreset)
  const overrides = React.useMemo(() => validOverrides(draft), [draft])

  const radiusInvalid = draft.radius.trim() !== '' && !isValidRadius(draft.radius.trim())
  const hasErrors =
    radiusInvalid ||
    THEME_MODES.some((m) =>
      Object.values(draft[m]).some((value) => value.trim() !== '' && !isValidColor(value)),
    )

  const setColor = (m: ThemeMode, token: ThemeColorToken, value: string) =>
    setDraft((d) => ({ ...d, [m]: { ...d[m], [token]: value } }))

  // Presets added without a message fall back to their built-in name.
  const presetName = (id: string, fallback: string) => {
    const key = `presets.${id}` as 'presets.default'
    return t.has(key) ? t(key) : fallback
  }

  async function save(event: React.FormEvent) {
    event.preventDefault()
    if (hasErrors) {
      toast.error(t('fixErrors'))
      return
    }
    setSaving(true)
    try {
      const { doc } = await statusPagesApi.update(orgId, page.id, toPatch(draft))
      onSaved(doc)
      setDraft(fromPage(doc))
      toast.success(t('saved'))
    } catch (error) {
      toast.error(error instanceof Error && error.message ? error.message : t('saveFailed'))
    } finally {
      setSaving(false)
    }
  }

  const overrideCount = Object.values(draft[mode]).filter((v) => v.trim()).length

  return (
    <form
      onSubmit={save}
      className="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]"
      data-theme-editor
    >
      <div className="flex min-w-0 flex-col gap-6">
        <Card>
          <CardHeader>
            <CardTitle>{t('mode.title')}</CardTitle>
            <CardDescription>{t('mode.description')}</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid max-w-xs gap-2">
              <Label htmlFor="theme-mode">{t('mode.label')}</Label>
              <Select
                value={draft.theme}
                disabled={!canEdit}
                onValueChange={(v) => {
                  setDraft((d) => ({ ...d, theme: v as Draft['theme'] }))
                  if (v === 'light' || v === 'dark') setMode(v)
                }}
              >
                <SelectTrigger id="theme-mode">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">{t('mode.auto')}</SelectItem>
                  <SelectItem value="light">{t('mode.light')}</SelectItem>
                  <SelectItem value="dark">{t('mode.dark')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t('preset.title')}</CardTitle>
            <CardDescription>{t('preset.description')}</CardDescription>
          </CardHeader>
          <CardContent>
            <div
              role="radiogroup"
              aria-label={t('preset.title')}
              className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3"
            >
              {THEME_PRESETS.map((p) => {
                const selected = p.id === draft.themePreset
                return (
                  <button
                    key={p.id}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    data-preset={p.id}
                    disabled={!canEdit}
                    onClick={() => setDraft((d) => ({ ...d, themePreset: p.id }))}
                    className={cn(
                      'flex flex-col gap-2 rounded-lg border p-3 text-left text-sm transition-colors hover:bg-muted/50 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60',
                      selected && 'border-primary ring-1 ring-primary',
                    )}
                  >
                    <span className="flex items-center justify-between gap-2 font-medium">
                      {presetName(p.id, p.name)}
                      {selected && (
                        <span className="text-xs font-normal text-primary">
                          {t('preset.selected')}
                        </span>
                      )}
                    </span>
                    <Swatches colors={p.light} />
                    <Swatches colors={p.dark} />
                  </button>
                )
              })}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t('overrides.title')}</CardTitle>
            <CardDescription>{t('overrides.description')}</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Tabs value={mode} onValueChange={(v) => setMode(v as ThemeMode)}>
                <TabsList>
                  <TabsTrigger value="light">{t('overrides.light')}</TabsTrigger>
                  <TabsTrigger value="dark">{t('overrides.dark')}</TabsTrigger>
                </TabsList>
              </Tabs>
              <span className="flex items-center gap-2 text-xs text-muted-foreground">
                {t('overrides.count', { count: overrideCount })}
                {overrideCount > 0 && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    disabled={!canEdit}
                    onClick={() => setDraft((d) => ({ ...d, [mode]: emptyColors() }))}
                  >
                    {t('overrides.clear', { mode: t(`overrides.${mode}`) })}
                  </Button>
                )}
              </span>
            </div>

            {TOKEN_GROUPS.map((group) => (
              <fieldset key={group.key} className="grid gap-2">
                <legend className="mb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">
                  {t(`overrides.groups.${group.key}`)}
                </legend>
                {group.tokens.map((token) => (
                  <ColorRow
                    key={`${mode}-${token}`}
                    token={token}
                    mode={mode}
                    value={draft[mode][token]}
                    presetValue={preset[mode][token]}
                    disabled={!canEdit}
                    onChange={(value) => setColor(mode, token, value)}
                  />
                ))}
              </fieldset>
            ))}

            <div className="grid max-w-xs gap-1">
              <Label htmlFor="theme-radius">{t('radius.label')}</Label>
              <Input
                id="theme-radius"
                value={draft.radius}
                className="h-8 font-mono text-xs"
                placeholder={preset.radius}
                aria-invalid={radiusInvalid || undefined}
                disabled={!canEdit}
                maxLength={16}
                onChange={(e) => setDraft((d) => ({ ...d, radius: e.target.value }))}
              />
              <p
                className={cn(
                  'text-xs',
                  radiusInvalid ? 'text-destructive' : 'text-muted-foreground',
                )}
              >
                {radiusInvalid ? t('radius.invalid') : t('radius.hint', { value: preset.radius })}
              </p>
            </div>

            <div role="status" className="rounded-lg border px-3 py-2 text-xs" data-contrast>
              <p className="font-medium">{t('contrast.title')}</p>
              {warnings.length === 0 ? (
                <p className="text-muted-foreground">
                  {t('contrast.ok', { mode: t(`overrides.${mode}`) })}
                </p>
              ) : (
                <ul className="mt-1 list-disc pl-4">
                  {warnings.map((w) => (
                    <li key={w.label}>
                      {t('contrast.low', {
                        pair: w.label,
                        ratio: format.number(w.ratio, { maximumFractionDigits: 1 }),
                        min: w.min,
                      })}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t('banner.title')}</CardTitle>
            <CardDescription>{t('banner.description')}</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-2">
            <Label htmlFor="theme-banner">{t('banner.label')}</Label>
            <Input
              id="theme-banner"
              value={draft.bannerText}
              maxLength={BANNER_MAX}
              placeholder={t('banner.placeholder')}
              disabled={!canEdit}
              onChange={(e) => setDraft((d) => ({ ...d, bannerText: e.target.value }))}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t('branding.title')}</CardTitle>
            <CardDescription>{t('branding.description')}</CardDescription>
          </CardHeader>
          <CardContent className="divide-y py-0">
            {(['logo', 'logoDark', 'favicon'] as const).map((kind) => (
              <AssetField
                key={kind}
                kind={kind}
                orgId={orgId}
                page={page}
                onSaved={onSaved}
                canEdit={canEdit}
              />
            ))}
          </CardContent>
        </Card>
      </div>

      <div className="flex min-w-0 flex-col gap-4 lg:sticky lg:top-4 lg:self-start">
        <Card>
          <CardHeader className="flex flex-row items-start justify-between gap-2">
            <div className="grid gap-1.5">
              <CardTitle>{t('preview.title')}</CardTitle>
              <CardDescription>{t('preview.description')}</CardDescription>
            </div>
            <Tabs value={mode} onValueChange={(v) => setMode(v as ThemeMode)}>
              <TabsList aria-label={t('preview.mode')}>
                <TabsTrigger value="light">{t('preview.light')}</TabsTrigger>
                <TabsTrigger value="dark">{t('preview.dark')}</TabsTrigger>
              </TabsList>
            </Tabs>
          </CardHeader>
          <CardContent>
            <ThemePreview
              title={page.title}
              presetId={draft.themePreset}
              overrides={overrides}
              mode={mode}
              bannerText={draft.bannerText}
              logo={mediaUrl(page.logo)}
              logoDark={mediaUrl(page.logoDark)}
            />
          </CardContent>
        </Card>

        <div className="flex items-center justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            disabled={!dirty || saving}
            onClick={() => setDraft(saved)}
          >
            {t('reset')}
          </Button>
          <Button type="submit" disabled={!canEdit || !dirty || saving}>
            {saving ? t('saving') : t('save')}
          </Button>
        </div>
      </div>
    </form>
  )
}
