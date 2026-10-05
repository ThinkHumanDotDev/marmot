'use client'

import { ArrowRightLeft, LogOut, Trash2 } from 'lucide-react'
import { useRouter } from 'next/navigation'
import * as React from 'react'
import { toast } from 'sonner'

import type { Role } from '@/access/permissions'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { OrgSummary } from '@/lib/org'
import { orgApi, type MemberRow } from '@/lib/org-api'

interface DangerZoneProps {
  org: OrgSummary
  role: Role | null
  currentUserId: string | number
  members: MemberRow[]
}

function Row({
  title,
  description,
  children,
}: {
  title: string
  description: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-3 py-4 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <p className="font-medium">{title}</p>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

/** Transfer ownership, leave, delete. Each action is confirmed in a dialog. */
export function OrganizationDangerZone({ org, role, currentUserId, members }: DangerZoneProps) {
  const router = useRouter()
  const [dialog, setDialog] = React.useState<'transfer' | 'leave' | 'delete' | null>(null)
  const [transferTo, setTransferTo] = React.useState<string>('')

  const isMember = members.some((m) => String(m.id) === String(currentUserId))
  const isOwner = role === 'owner'
  const ownerCount = members.filter((m) => m.role === 'owner').length
  const lastOwner = isOwner && isMember && ownerCount <= 1
  const candidates = members.filter((m) => String(m.id) !== String(currentUserId))

  async function transfer() {
    if (!transferTo) return
    try {
      await orgApi.transferOwnership(org.id, transferTo)
      const target = candidates.find((m) => String(m.id) === transferTo)
      toast.success(`${target?.name || target?.email || 'The member'} now owns ${org.name}`)
      setDialog(null)
      router.refresh()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not transfer ownership.')
    }
  }

  async function leave() {
    try {
      await orgApi.removeMember(org.id, currentUserId)
      toast.success(`You left ${org.name}`)
      router.replace('/')
      router.refresh()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not leave the organization.')
    }
  }

  async function remove() {
    try {
      await orgApi.remove(org.id)
      toast.success(`${org.name} deleted`)
      router.replace('/')
      router.refresh()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not delete the organization.')
    }
  }

  return (
    <Card className="border-destructive/40">
      <CardHeader>
        <CardTitle className="text-destructive">Danger zone</CardTitle>
        <CardDescription>These actions are permanent or hard to undo.</CardDescription>
      </CardHeader>
      <CardContent className="divide-y">
        {isOwner && (
          <Row
            title="Transfer ownership"
            description="Make another member the owner. You stay in the organization as an admin."
          >
            <Button
              variant="outline"
              onClick={() => setDialog('transfer')}
              disabled={candidates.length === 0}
            >
              <ArrowRightLeft /> Transfer
            </Button>
          </Row>
        )}
        {isMember && (
          <Row
            title="Leave organization"
            description={
              lastOwner
                ? 'You are the only owner. Transfer ownership before leaving.'
                : 'You will lose access until someone invites you again.'
            }
          >
            <Button variant="outline" onClick={() => setDialog('leave')} disabled={lastOwner}>
              <LogOut /> Leave
            </Button>
          </Row>
        )}
        {isOwner && (
          <Row
            title="Delete organization"
            description="Removes every monitor, status page and member. There is no undo."
          >
            <Button variant="destructive" onClick={() => setDialog('delete')}>
              <Trash2 /> Delete
            </Button>
          </Row>
        )}
        {!isOwner && !isMember && (
          <p className="text-sm text-muted-foreground">Nothing to do here for your role.</p>
        )}
      </CardContent>

      <ConfirmDialog
        open={dialog === 'transfer'}
        onOpenChange={(open) => !open && setDialog(null)}
        title={`Transfer ownership of ${org.name}`}
        description="The new owner gets full control, including deleting the organization. You become an admin."
        confirmLabel="Transfer ownership"
        onConfirm={transfer}
      >
        <div className="grid gap-2">
          <Label>New owner</Label>
          <Select value={transferTo} onValueChange={setTransferTo}>
            <SelectTrigger className="w-full" aria-label="New owner">
              <SelectValue placeholder="Choose a member" />
            </SelectTrigger>
            <SelectContent position="popper">
              {candidates.map((m) => (
                <SelectItem key={String(m.id)} value={String(m.id)}>
                  {m.name ? `${m.name} (${m.email})` : m.email}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </ConfirmDialog>

      <ConfirmDialog
        open={dialog === 'leave'}
        onOpenChange={(open) => !open && setDialog(null)}
        title={`Leave ${org.name}?`}
        description="You will be signed out of this organization and lose access to its monitors."
        confirmLabel="Leave organization"
        destructive
        onConfirm={leave}
      />

      <ConfirmDialog
        open={dialog === 'delete'}
        onOpenChange={(open) => !open && setDialog(null)}
        title={`Delete ${org.name}?`}
        description="All monitors, heartbeats, status pages, invitations and memberships will be deleted permanently."
        confirmText={org.slug}
        confirmLabel="Delete organization"
        destructive
        onConfirm={remove}
      />
    </Card>
  )
}
