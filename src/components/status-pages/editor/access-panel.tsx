'use client'

import { Globe, LockKeyhole, Mail, Network } from 'lucide-react'
import { useTranslations } from 'next-intl'
import * as React from 'react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  STATUS_PAGE_ACCESS_MODES,
  STATUS_PAGE_PASSWORD_MIN_LENGTH as MIN_PASSWORD_LENGTH,
  type StatusPageAccessMode,
} from '@/lib/status-page-access'
import { cn } from '@/lib/utils'
import type { StatusPage } from '@/payload-types'

import { statusPagesApi, type OrgId, type StatusPagePatch } from '../api'
import { ViewersList } from './viewers-list'

const ICONS: Record<StatusPageAccessMode, React.ComponentType<{ className?: string }>> = {
  public: Globe,
  password: LockKeyhole,
  'email-domain': Mail,
  'ip-allowlist': Network,
}

type Ranges = NonNullable<StatusPage['allowedIpRanges']>

const domainsToText = (page: StatusPage) =>
  (page.allowedEmailDomains ?? []).map((row) => row.domain).join('\n')

const rangesToText = (page: StatusPage) =>
  (page.allowedIpRanges ?? [])
    .map((row) => (row.label ? `${row.cidr} ${row.label}` : row.cidr))
    .join('\n')

const lines = (text: string) =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)

/** `203.0.113.0/24 Office` → `{ cidr, label }`; the server validates and normalizes the range. */
const textToRanges = (text: string): Ranges =>
  lines(text).map((line) => {
    const [cidr, ...label] = line.split(/\s+/)
    return { cidr, label: label.join(' ') || null }
  })

/**
 * Who may view the published page: everyone, visitors who know the page password, visitors with an
 * email address at an allowed domain (magic link), or visitors from allowed IP ranges.
 */
export function AccessPanel({
  orgId,
  page,
  onSaved,
  canEdit,
  trustProxy,
  timeZone,
}: {
  orgId: OrgId
  page: StatusPage
  onSaved: (page: StatusPage) => void
  canEdit: boolean
  /** Instance setting: without it, client addresses are unknown and an IP allow-list admits nobody. */
  trustProxy: boolean
  /** Organization time zone for the visitors' "last seen" times. */
  timeZone: string
}) {
  const t = useTranslations('statusPages.access.editor')
  const saved: StatusPageAccessMode = page.access ?? 'public'
  const [mode, setMode] = React.useState<StatusPageAccessMode>(saved)
  const [password, setPassword] = React.useState('')
  const [domains, setDomains] = React.useState(() => domainsToText(page))
  const [ranges, setRanges] = React.useState(() => rangesToText(page))
  const [saving, setSaving] = React.useState(false)

  // A protected page always has a password: the server refuses `password` mode without one.
  const hasPassword = saved === 'password'
  const needsPassword = mode === 'password' && !hasPassword
  const tooShort = password.length > 0 && password.length < MIN_PASSWORD_LENGTH
  const domainsChanged = domains.trim() !== domainsToText(page).trim()
  const rangesChanged = ranges.trim() !== rangesToText(page).trim()
  const missingList =
    (mode === 'email-domain' && lines(domains).length === 0) ||
    (mode === 'ip-allowlist' && lines(ranges).length === 0)
  const dirty =
    mode !== saved ||
    password.length > 0 ||
    (mode === 'email-domain' && domainsChanged) ||
    (mode === 'ip-allowlist' && rangesChanged)
  const canSave =
    canEdit && dirty && !saving && !tooShort && !(needsPassword && !password) && !missingList

  function reset() {
    setMode(saved)
    setPassword('')
    setDomains(domainsToText(page))
    setRanges(rangesToText(page))
  }

  async function save(event: React.FormEvent) {
    event.preventDefault()
    if (!canSave) return
    setSaving(true)
    try {
      const patch: StatusPagePatch = { access: mode }
      if (mode === 'password' && password) patch.password = password
      if (mode === 'email-domain') {
        patch.allowedEmailDomains = lines(domains).map((domain) => ({ domain }))
      }
      if (mode === 'ip-allowlist') patch.allowedIpRanges = textToRanges(ranges)
      const { doc } = await statusPagesApi.update(orgId, page.id, patch)
      onSaved(doc)
      setMode(doc.access ?? 'public')
      setPassword('')
      setDomains(domainsToText(doc))
      setRanges(rangesToText(doc))
      toast.success(t('saved'))
    } catch (error) {
      toast.error(error instanceof Error && error.message ? error.message : t('saveFailed'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex flex-col gap-8">
      <form onSubmit={save} className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div className="flex flex-col gap-4">
          <div>
            <h2 className="text-base font-medium">{t('title')}</h2>
            <p className="text-sm text-muted-foreground">{t('description')}</p>
          </div>

          <fieldset className="grid gap-2" disabled={!canEdit}>
            <legend className="sr-only">{t('title')}</legend>
            {STATUS_PAGE_ACCESS_MODES.map((value) => {
              const Icon = ICONS[value]
              return (
                <label
                  key={value}
                  className={cn(
                    'flex cursor-pointer items-start gap-3 rounded-xl border px-4 py-3 transition-colors',
                    mode === value ? 'border-primary bg-primary/5' : 'hover:bg-muted/50',
                  )}
                >
                  <input
                    type="radio"
                    name="access"
                    value={value}
                    checked={mode === value}
                    onChange={() => setMode(value)}
                    className="mt-1 accent-primary"
                  />
                  <span className="flex flex-col gap-0.5">
                    <span className="inline-flex items-center gap-2 text-sm font-medium">
                      <Icon className="size-4 text-muted-foreground" aria-hidden />
                      {t(`modes.${value}.label`)}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {t(`modes.${value}.hint`)}
                    </span>
                  </span>
                </label>
              )
            })}
          </fieldset>

          {mode === 'password' && (
            <div className="grid gap-2">
              <Label htmlFor="sp-access-password">
                {hasPassword ? t('newPassword') : t('password')}
              </Label>
              <Input
                id="sp-access-password"
                type="password"
                autoComplete="new-password"
                value={password}
                disabled={!canEdit}
                minLength={MIN_PASSWORD_LENGTH}
                required={needsPassword}
                aria-invalid={tooShort || undefined}
                aria-describedby="sp-access-password-hint"
                onChange={(e) => setPassword(e.target.value)}
              />
              <p id="sp-access-password-hint" className="text-xs text-muted-foreground">
                {hasPassword
                  ? t('passwordSet', { min: MIN_PASSWORD_LENGTH })
                  : t('passwordHint', { min: MIN_PASSWORD_LENGTH })}
              </p>
            </div>
          )}

          {mode === 'email-domain' && (
            <div className="grid gap-2">
              <Label htmlFor="sp-access-domains">{t('domains.label')}</Label>
              <Textarea
                id="sp-access-domains"
                value={domains}
                rows={4}
                disabled={!canEdit}
                spellCheck={false}
                placeholder={t('domains.placeholder')}
                aria-describedby="sp-access-domains-hint"
                onChange={(e) => setDomains(e.target.value)}
              />
              <p id="sp-access-domains-hint" className="text-xs text-muted-foreground">
                {lines(domains).length === 0 ? t('domains.required') : t('domains.hint')}
              </p>
            </div>
          )}

          {mode === 'ip-allowlist' && (
            <div className="grid gap-2">
              <Label htmlFor="sp-access-ranges">{t('ranges.label')}</Label>
              <Textarea
                id="sp-access-ranges"
                value={ranges}
                rows={5}
                disabled={!canEdit}
                spellCheck={false}
                className="font-mono text-xs"
                placeholder={t('ranges.placeholder')}
                aria-describedby="sp-access-ranges-hint"
                onChange={(e) => setRanges(e.target.value)}
              />
              <p id="sp-access-ranges-hint" className="text-xs text-muted-foreground">
                {lines(ranges).length === 0 ? t('ranges.required') : t('ranges.hint')}
              </p>
              <p
                role={trustProxy ? undefined : 'alert'}
                className={cn(
                  'rounded-md px-3 py-2 text-xs',
                  trustProxy
                    ? 'bg-muted/50 text-muted-foreground'
                    : 'border border-destructive/30 bg-destructive/10 text-destructive',
                )}
              >
                {trustProxy ? t('ranges.trustProxyOn') : t('ranges.trustProxyOff')}
              </p>
            </div>
          )}

          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" disabled={!dirty || saving} onClick={reset}>
              {t('reset')}
            </Button>
            <Button type="submit" disabled={!canSave}>
              {saving ? t('saving') : t('save')}
            </Button>
          </div>
        </div>

        {mode === 'password' && (
          <aside className="h-fit rounded-xl border bg-muted/40 p-4 text-sm">
            <h3 className="font-medium">{t('machine.title')}</h3>
            <p className="mt-2 text-muted-foreground">
              {t.rich('machine.body', { code: (chunks) => <code>{chunks}</code> })}
            </p>
            <p className="mt-2 text-muted-foreground">{t('machine.warning')}</p>
          </aside>
        )}
      </form>

      {saved === 'email-domain' && (
        <ViewersList orgId={orgId} pageId={page.id} canEdit={canEdit} timeZone={timeZone} />
      )}
    </div>
  )
}
