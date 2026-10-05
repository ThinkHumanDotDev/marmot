'use client'

import { Check, Copy, Link2, Link2Off, RefreshCw } from 'lucide-react'
import { useRouter } from 'next/navigation'
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
  const router = useRouter()
  const [role, setRole] = React.useState<Role>(link.role)
  const [busy, setBusy] = React.useState(false)
  const [copied, setCopied] = React.useState(false)
  const options = assignableRoles(viewerRole)

  async function regenerate() {
    setBusy(true)
    try {
      await orgApi.regenerateInviteLink(orgId, role)
      toast.success(link.url ? 'Invite link regenerated' : 'Invite link created')
      router.refresh()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not update the invite link.')
    } finally {
      setBusy(false)
    }
  }

  async function disable() {
    setBusy(true)
    try {
      await orgApi.disableInviteLink(orgId)
      toast.success('Invite link disabled')
      router.refresh()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not disable the invite link.')
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
      toast.error('Copy failed. Select the link and copy it manually.')
    }
  }

  return (
    <Card data-testid="invite-link-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Link2 className="size-4 text-muted-foreground" aria-hidden /> Invite link
        </CardTitle>
        <CardDescription>
          Anyone with this link can join as the selected role. Regenerate it to invalidate links you
          have already shared.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <Input
            readOnly
            value={link.url ?? ''}
            placeholder="No active invite link"
            aria-label="Invite link"
            onFocus={(e) => e.currentTarget.select()}
            className="font-mono text-xs"
          />
          <Button
            variant="outline"
            onClick={copy}
            disabled={!link.url}
            aria-label="Copy invite link"
          >
            {copied ? <Check /> : <Copy />} {copied ? 'Copied' : 'Copy'}
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-muted-foreground">Joins as</span>
          <RoleSelect
            size="sm"
            value={role}
            options={options}
            onChange={setRole}
            disabled={busy}
            aria-label="Invite link role"
          />
          <Button size="sm" onClick={regenerate} disabled={busy}>
            <RefreshCw /> {link.url ? 'Regenerate' : 'Create link'}
          </Button>
          {link.url && (
            <Button size="sm" variant="ghost" onClick={disable} disabled={busy}>
              <Link2Off /> Disable
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
