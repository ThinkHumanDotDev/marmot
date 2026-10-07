'use client'

import { Globe, LockKeyhole } from 'lucide-react'
import { useTranslations } from 'next-intl'
import * as React from 'react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  STATUS_PAGE_ACCESS_MODES,
  STATUS_PAGE_PASSWORD_MIN_LENGTH as MIN_PASSWORD_LENGTH,
  type StatusPageAccessMode,
} from '@/lib/status-page-access'
import { cn } from '@/lib/utils'
import type { StatusPage } from '@/payload-types'

import { statusPagesApi, type OrgId } from '../api'

const ICONS: Record<StatusPageAccessMode, React.ComponentType<{ className?: string }>> = {
  public: Globe,
  password: LockKeyhole,
}

/** Who may view the published page: everyone, or visitors who know the page password. */
export function AccessPanel({
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
  const t = useTranslations('statusPages.access.editor')
  const saved: StatusPageAccessMode = page.access ?? 'public'
  const [mode, setMode] = React.useState<StatusPageAccessMode>(saved)
  const [password, setPassword] = React.useState('')
  const [saving, setSaving] = React.useState(false)

  // A protected page always has a password: the server refuses `password` mode without one.
  const hasPassword = saved === 'password'
  const needsPassword = mode === 'password' && !hasPassword
  const tooShort = password.length > 0 && password.length < MIN_PASSWORD_LENGTH
  const dirty = mode !== saved || password.length > 0
  const canSave = canEdit && dirty && !saving && !tooShort && !(needsPassword && !password)

  async function save(event: React.FormEvent) {
    event.preventDefault()
    if (!canSave) return
    setSaving(true)
    try {
      const { doc } = await statusPagesApi.update(orgId, page.id, {
        access: mode,
        ...(mode === 'password' && password ? { password } : {}),
      })
      onSaved(doc)
      setMode(doc.access ?? 'public')
      setPassword('')
      toast.success(t('saved'))
    } catch (error) {
      toast.error(error instanceof Error && error.message ? error.message : t('saveFailed'))
    } finally {
      setSaving(false)
    }
  }

  return (
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
                  <span className="text-xs text-muted-foreground">{t(`modes.${value}.hint`)}</span>
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

        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            disabled={!dirty || saving}
            onClick={() => {
              setMode(saved)
              setPassword('')
            }}
          >
            {t('reset')}
          </Button>
          <Button type="submit" disabled={!canSave}>
            {saving ? t('saving') : t('save')}
          </Button>
        </div>
      </div>

      <aside className="rounded-xl border bg-muted/40 p-4 text-sm">
        <h3 className="font-medium">{t('machine.title')}</h3>
        <p className="mt-2 text-muted-foreground">
          {t.rich('machine.body', { code: (chunks) => <code>{chunks}</code> })}
        </p>
        <p className="mt-2 text-muted-foreground">{t('machine.warning')}</p>
      </aside>
    </form>
  )
}
