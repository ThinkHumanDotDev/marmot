'use client'

import { MailPlus, MoreHorizontal, RefreshCw, X } from 'lucide-react'
import { useRouter } from 'next/navigation'
import * as React from 'react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { orgApi, type InvitationRow } from '@/lib/org-api'

import { RoleBadge } from './role-badge'

interface PendingInvitationsProps {
  orgId: string | number
  invitations: InvitationRow[]
  onInvite: () => void
}

const formatDate = (iso: string | null) =>
  iso ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(iso)) : '—'

export function PendingInvitations({ orgId, invitations, onInvite }: PendingInvitationsProps) {
  const router = useRouter()
  const [busyId, setBusyId] = React.useState<string | number | null>(null)

  async function run(invitation: InvitationRow, action: 'resend' | 'revoke') {
    setBusyId(invitation.id)
    try {
      if (action === 'resend') {
        await orgApi.resendInvitation(orgId, invitation.id)
        toast.success(`Invitation re-sent to ${invitation.email}`)
      } else {
        await orgApi.revokeInvitation(invitation.id)
        toast.success(`Invitation to ${invitation.email} revoked`)
      }
      router.refresh()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Something went wrong.')
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="flex flex-col gap-3" data-testid="pending-invitations">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold">Pending invitations</h2>
          <p className="text-sm text-muted-foreground">
            Invitations expire after seven days. Resend to extend them.
          </p>
        </div>
      </div>
      {invitations.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed px-6 py-10 text-center">
          <p className="text-sm text-muted-foreground">No pending invitations.</p>
          <Button variant="outline" size="sm" onClick={onInvite}>
            <MailPlus /> Invite someone
          </Button>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Email</TableHead>
                <TableHead className="w-28">Role</TableHead>
                <TableHead className="w-36">Expires</TableHead>
                <TableHead className="w-12">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {invitations.map((invitation) => (
                <TableRow key={String(invitation.id)} data-testid="invitation-row">
                  <TableCell className="font-medium">{invitation.email}</TableCell>
                  <TableCell>
                    <RoleBadge role={invitation.role} />
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {formatDate(invitation.expiresAt)}
                  </TableCell>
                  <TableCell className="text-right">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          disabled={busyId === invitation.id}
                          aria-label={`Actions for invitation to ${invitation.email}`}
                        >
                          <MoreHorizontal />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onSelect={() => run(invitation, 'resend')}>
                          <RefreshCw /> Resend email
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          variant="destructive"
                          onSelect={() => run(invitation, 'revoke')}
                        >
                          <X /> Revoke
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  )
}
