'use client'

import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import * as React from 'react'
import { toast } from 'sonner'

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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { instanceApi, type InstanceSettingsInput } from '@/lib/org-api'
import type { InstanceSettings } from '@/server/settings'

interface InstanceSettingsFormProps {
  /** Stored values with env defaults applied (`resolveInstanceSettings`). */
  settings: InstanceSettings
}

interface FormState {
  primaryBaseUrl: string
  allowSignup: boolean
  requireEmailVerification: boolean
  magicLinkEnabled: boolean
  entryPage: 'dashboard' | 'status-page'
  tlsExpiryNotifyDays: string
  domainExpiryNotifyDays: string
  keepDataPeriodDays: string
  trustProxy: boolean
  steamApiKey: string
  globalpingApiToken: string
}

const toForm = (s: InstanceSettings): FormState => ({
  primaryBaseUrl: s.primaryBaseUrl,
  allowSignup: s.allowSignup,
  requireEmailVerification: s.requireEmailVerification,
  magicLinkEnabled: s.magicLinkEnabled,
  entryPage: s.entryPage,
  tlsExpiryNotifyDays: s.tlsExpiryNotifyDays.join(', '),
  domainExpiryNotifyDays: s.domainExpiryNotifyDays.join(', '),
  keepDataPeriodDays: String(s.keepDataPeriodDays),
  trustProxy: s.trustProxy,
  steamApiKey: s.steamApiKey ?? '',
  globalpingApiToken: s.globalpingApiToken ?? '',
})

/** "7, 14, 21" → [7, 14, 21]; `null` when any entry is not a positive integer. */
function parseDays(input: string): number[] | null {
  const parts = input
    .split(/[\s,]+/)
    .map((p) => p.trim())
    .filter(Boolean)
  const days = parts.map(Number)
  if (days.some((d) => !Number.isInteger(d) || d < 1)) return null
  return [...new Set(days)].sort((a, b) => a - b)
}

/**
 * Every field of the `instance-settings` global, saved through Payload REST
 * (`POST /api/globals/instance-settings`, superadmin-only). Secrets are write-only here: a saved
 * key shows as set, and leaving the field blank keeps it.
 */
export function InstanceSettingsForm({ settings }: InstanceSettingsFormProps) {
  const t = useTranslations('settings.instance')
  const router = useRouter()
  const [form, setForm] = React.useState<FormState>(() => toForm(settings))
  const [pending, setPending] = React.useState(false)
  const id = React.useId()
  const field = (name: keyof FormState) => `${id}-${name}`
  const set = <K extends keyof FormState>(name: K, value: FormState[K]) =>
    setForm((f) => ({ ...f, [name]: value }))

  async function save(event: React.FormEvent) {
    event.preventDefault()
    const tls = parseDays(form.tlsExpiryNotifyDays)
    const domain = parseDays(form.domainExpiryNotifyDays)
    const keep = Number(form.keepDataPeriodDays)
    if (!tls || !domain) {
      toast.error(t('errors.expiryDays'))
      return
    }
    if (!Number.isInteger(keep) || keep < 0) {
      toast.error(t('errors.retention'))
      return
    }
    let baseUrl = form.primaryBaseUrl.trim()
    try {
      baseUrl = new URL(baseUrl).origin + new URL(baseUrl).pathname.replace(/\/$/, '')
    } catch {
      toast.error(t('errors.baseUrl'))
      return
    }

    const data: InstanceSettingsInput = {
      primaryBaseUrl: baseUrl,
      allowSignup: form.allowSignup,
      requireEmailVerification: form.requireEmailVerification,
      magicLinkEnabled: form.magicLinkEnabled,
      entryPage: form.entryPage,
      tlsExpiryNotifyDays: tls,
      domainExpiryNotifyDays: domain,
      keepDataPeriodDays: keep,
      trustProxy: form.trustProxy,
      steamApiKey: form.steamApiKey.trim() || null,
      globalpingApiToken: form.globalpingApiToken.trim() || null,
    }
    setPending(true)
    try {
      await instanceApi.update(data)
      toast.success(t('saved'))
      router.refresh()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('failed'))
    } finally {
      setPending(false)
    }
  }

  return (
    <Card>
      <form onSubmit={save}>
        <CardHeader>
          <CardTitle>{t('title')}</CardTitle>
          <CardDescription>{t('description')}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-6 pt-6">
          <div className="grid gap-2">
            <Label htmlFor={field('primaryBaseUrl')}>{t('baseUrl')}</Label>
            <Input
              id={field('primaryBaseUrl')}
              type="url"
              value={form.primaryBaseUrl}
              onChange={(e) => set('primaryBaseUrl', e.target.value)}
              placeholder="https://status.example.com"
              required
            />
            <p className="text-xs text-muted-foreground">{t('baseUrlHint')}</p>
          </div>

          <ToggleRow
            id={field('allowSignup')}
            label={t('allowSignup')}
            hint={t('allowSignupHint')}
            checked={form.allowSignup}
            onChange={(v) => set('allowSignup', v)}
          />

          <ToggleRow
            id={field('requireEmailVerification')}
            label={t('requireEmailVerification')}
            hint={t('requireEmailVerificationHint')}
            checked={form.requireEmailVerification}
            onChange={(v) => set('requireEmailVerification', v)}
          />

          <ToggleRow
            id={field('magicLinkEnabled')}
            label={t('magicLinkEnabled')}
            hint={t('magicLinkEnabledHint')}
            checked={form.magicLinkEnabled}
            onChange={(v) => set('magicLinkEnabled', v)}
          />

          <div className="grid gap-2">
            <Label htmlFor={field('entryPage')}>{t('entryPage')}</Label>
            <Select
              value={form.entryPage}
              onValueChange={(v) => set('entryPage', v as FormState['entryPage'])}
            >
              <SelectTrigger id={field('entryPage')} className="w-full sm:w-64">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="dashboard">{t('entryPageDashboard')}</SelectItem>
                <SelectItem value="status-page">{t('entryPageStatusPage')}</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">{t('entryPageHint')}</p>
          </div>

          <div className="grid gap-5 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor={field('tlsExpiryNotifyDays')}>{t('tlsExpiryDays')}</Label>
              <Input
                id={field('tlsExpiryNotifyDays')}
                value={form.tlsExpiryNotifyDays}
                onChange={(e) => set('tlsExpiryNotifyDays', e.target.value)}
                placeholder="7, 14, 21"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor={field('domainExpiryNotifyDays')}>{t('domainExpiryDays')}</Label>
              <Input
                id={field('domainExpiryNotifyDays')}
                value={form.domainExpiryNotifyDays}
                onChange={(e) => set('domainExpiryNotifyDays', e.target.value)}
                placeholder="7, 14, 21"
              />
            </div>
          </div>

          <div className="grid gap-2">
            <Label htmlFor={field('keepDataPeriodDays')}>{t('retention')}</Label>
            <Input
              id={field('keepDataPeriodDays')}
              type="number"
              min={0}
              step={1}
              className="sm:w-40"
              value={form.keepDataPeriodDays}
              onChange={(e) => set('keepDataPeriodDays', e.target.value)}
            />
            <p className="text-xs text-muted-foreground">{t('retentionHint')}</p>
          </div>

          <ToggleRow
            id={field('trustProxy')}
            label={t('trustProxy')}
            hint={t('trustProxyHint')}
            checked={form.trustProxy}
            onChange={(v) => set('trustProxy', v)}
          />

          <fieldset className="grid gap-5 rounded-lg border p-4">
            <legend className="px-1 text-sm font-medium">{t('thirdParty')}</legend>
            <div className="grid gap-2">
              <Label htmlFor={field('steamApiKey')}>{t('steamApiKey')}</Label>
              <Input
                id={field('steamApiKey')}
                type="password"
                autoComplete="off"
                value={form.steamApiKey}
                onChange={(e) => set('steamApiKey', e.target.value)}
                placeholder={settings.steamApiKey ? t('secretSaved') : t('secretNotSet')}
              />
              <p className="text-xs text-muted-foreground">{t('steamApiKeyHint')}</p>
            </div>
            <div className="grid gap-2">
              <Label htmlFor={field('globalpingApiToken')}>{t('globalpingApiToken')}</Label>
              <Input
                id={field('globalpingApiToken')}
                type="password"
                autoComplete="off"
                value={form.globalpingApiToken}
                onChange={(e) => set('globalpingApiToken', e.target.value)}
                placeholder={settings.globalpingApiToken ? t('secretSaved') : t('secretNotSet')}
              />
              <p className="text-xs text-muted-foreground">{t('globalpingApiTokenHint')}</p>
            </div>
          </fieldset>
        </CardContent>
        <CardFooter className="justify-end gap-2 border-t pt-6">
          <Button
            type="button"
            variant="outline"
            onClick={() => setForm(toForm(settings))}
            disabled={pending}
          >
            {t('discard')}
          </Button>
          <Button type="submit" disabled={pending}>
            {pending ? t('saving') : t('save')}
          </Button>
        </CardFooter>
      </form>
    </Card>
  )
}

function ToggleRow({
  id,
  label,
  hint,
  checked,
  onChange,
}: {
  id: string
  label: string
  hint: string
  checked: boolean
  onChange: (value: boolean) => void
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="grid gap-1">
        <Label htmlFor={id}>{label}</Label>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
    </div>
  )
}
