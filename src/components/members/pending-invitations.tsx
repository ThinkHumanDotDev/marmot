'use client'

import { MailPlus, MoreHorizontal, RefreshCw, X } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useFormatter, useTranslations } from 'next-intl'
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

export function PendingInvitations({ orgId, invitations, onInvite }: PendingInvitationsProps) {
  const t = useTranslations('members.pending')
  const format = useFormatter()
  const formatDate = (iso: string | null) => (iso ? format.dateTime(new Date(iso), 'date') : '—')
  const router = useRouter()
  const [busyId, setBusyId] = React.useState<string | number | null>(null)

  async function run(invitation: InvitationRow, action: 'resend' | 'revoke') {
    setBusyId(invitation.id)
    try {
      if (action === 'resend') {
        await orgApi.resendInvitation(orgId, invitation.id)
        toast.success(t('resent', { email: invitation.email }))
      } else {
        await orgApi.revokeInvitation(invitation.id)
        toast.success(t('revoked', { email: invitation.email }))
      }
      router.refresh()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('failed'))
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="flex flex-col gap-3" data-testid="pending-invitations">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold">{t('title')}</h2>
          <p className="text-sm text-muted-foreground">{t('description')}</p>
        </div>
      </div>
      {invitations.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed px-6 py-10 text-center">
          <p className="text-sm text-muted-foreground">{t('empty')}</p>
          <Button variant="outline" size="sm" onClick={onInvite}>
            <MailPlus /> {t('invite')}
          </Button>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('columns.email')}</TableHead>
                <TableHead className="w-28">{t('columns.role')}</TableHead>
                <TableHead className="w-36">{t('columns.expires')}</TableHead>
                <TableHead className="w-12">
                  <span className="sr-only">{t('columns.actions')}</span>
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
                          aria-label={t('actionsFor', { email: invitation.email })}
                        >
                          <MoreHorizontal />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onSelect={() => run(invitation, 'resend')}>
                          <RefreshCw /> {t('resend')}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          variant="destructive"
                          onSelect={() => run(invitation, 'revoke')}
                        >
                          <X /> {t('revoke')}
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
