'use client'

import { Check, Copy, Link2, Link2Off, RefreshCw } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import * as React from 'react'
import { toast } from 'sonner'

import type { Role } from '@/access/permissions'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { orgApi, type InviteLink } from '@/lib/org-api'

import { assignableRoles } from './role-badge'
import { RoleSelect } from './role-select'

interface InviteLinkCardProps {
  orgId: string | number
  link: InviteLink
  viewerRole: Role | null
}

/** Shareable invite link: anyone with the URL joins with the configured role. */
export function InviteLinkCard({ orgId, link, viewerRole }: InviteLinkCardProps) {
  const t = useTranslations('members.inviteLink')
  const router = useRouter()
  const [role, setRole] = React.useState<Role>(link.role)
  const [busy, setBusy] = React.useState(false)
  const [copied, setCopied] = React.useState(false)
  const options = assignableRoles(viewerRole)

  async function regenerate() {
    setBusy(true)
    try {
      await orgApi.regenerateInviteLink(orgId, role)
      toast.success(link.url ? t('regenerated') : t('created'))
      router.refresh()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('updateFailed'))
    } finally {
      setBusy(false)
    }
  }

  async function disable() {
    setBusy(true)
    try {
      await orgApi.disableInviteLink(orgId)
      toast.success(t('disabled'))
      router.refresh()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('disableFailed'))
    } finally {
      setBusy(false)
    }
  }

  async function copy() {
    if (!link.url) return
    try {
      await navigator.clipboard.writeText(link.url)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      toast.error(t('copyFailed'))
    }
  }

  return (
    <Card data-testid="invite-link-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Link2 className="size-4 text-muted-foreground" aria-hidden /> {t('title')}
        </CardTitle>
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <Input
            readOnly
            value={link.url ?? ''}
            placeholder={t('none')}
            aria-label={t('title')}
            onFocus={(e) => e.currentTarget.select()}
            className="font-mono text-xs"
          />
          <Button variant="outline" onClick={copy} disabled={!link.url} aria-label={t('copyLabel')}>
            {copied ? <Check /> : <Copy />} {copied ? t('copied') : t('copy')}
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-muted-foreground">{t('joinsAs')}</span>
          <RoleSelect
            size="sm"
            value={role}
            options={options}
            onChange={setRole}
            disabled={busy}
            aria-label={t('roleLabel')}
          />
          <Button size="sm" onClick={regenerate} disabled={busy}>
            <RefreshCw /> {link.url ? t('regenerate') : t('create')}
          </Button>
          {link.url && (
            <Button size="sm" variant="ghost" onClick={disable} disabled={busy}>
              <Link2Off /> {t('disable')}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
