'use client'

import { MoreHorizontal, UserMinus } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import * as React from 'react'
import { toast } from 'sonner'

import { can, canManageRole, type Role } from '@/access/permissions'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
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
import { orgApi, type MemberRow } from '@/lib/org-api'
import { initials } from '@/lib/utils'

import { assignableRoles, RoleBadge } from './role-badge'
import { RoleSelect } from './role-select'

interface MembersTableProps {
  orgId: string | number
  orgSlug: string
  currentUserId: string | number
  viewerRole: Role | null
  members: MemberRow[]
}

export function MembersTable({
  orgId,
  orgSlug,
  currentUserId,
  viewerRole,
  members,
}: MembersTableProps) {
  const t = useTranslations('members.table')
  const router = useRouter()
  const [removing, setRemoving] = React.useState<MemberRow | null>(null)
  const [busyId, setBusyId] = React.useState<string | number | null>(null)

  const viewer = {
    id: currentUserId,
    organizations: viewerRole ? [{ organization: orgId, role: viewerRole }] : [],
  }
  const canUpdateRole = can(viewer, orgId, 'member:update-role')
  const canRemove = can(viewer, orgId, 'member:remove')
  const ownerCount = members.filter((m) => m.role === 'owner').length
  const options = assignableRoles(viewerRole)

  const manageable = (member: MemberRow) =>
    !!viewerRole &&
    canManageRole(viewerRole, member.role) &&
    String(member.id) !== String(currentUserId)

  async function changeRole(member: MemberRow, role: Role) {
    if (role === member.role) return
    setBusyId(member.id)
    try {
      await orgApi.updateMemberRole(orgId, member.id, role)
      toast.success(t('roleChanged', { member: member.name || member.email, role }))
      router.refresh()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('roleFailed'))
    } finally {
      setBusyId(null)
    }
  }

  async function remove(member: MemberRow) {
    try {
      await orgApi.removeMember(orgId, member.id)
      toast.success(t('removed', { member: member.name || member.email }))
      setRemoving(null)
      router.refresh()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('removeFailed'))
    }
  }

  return (
    <div className="overflow-hidden rounded-xl border" data-testid="members-table">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t('columns.member')}</TableHead>
            <TableHead className="w-40">{t('columns.role')}</TableHead>
            <TableHead className="w-12">
              <span className="sr-only">{t('columns.actions')}</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {members.map((member) => {
            const isSelf = String(member.id) === String(currentUserId)
            const lastOwner = member.role === 'owner' && ownerCount <= 1
            const editable = canUpdateRole && manageable(member) && !lastOwner
            const label = member.name?.trim() || member.email
            return (
              <TableRow key={String(member.id)} data-testid="member-row">
                <TableCell>
                  <div className="flex items-center gap-3">
                    <Avatar className="size-9 rounded-md">
                      {member.avatarUrl && <AvatarImage src={member.avatarUrl} alt="" />}
                      <AvatarFallback className="rounded-md bg-primary/15 text-xs font-semibold text-foreground">
                        {initials(label)}
                      </AvatarFallback>
                    </Avatar>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="truncate font-medium">{label}</span>
                        {isSelf && (
                          <Badge variant="outline" className="text-[10px]">
                            {t('you')}
                          </Badge>
                        )}
                      </div>
                      {member.name && (
                        <div className="truncate text-xs text-muted-foreground">{member.email}</div>
                      )}
                    </div>
                  </div>
                </TableCell>
                <TableCell>
                  {editable ? (
                    <RoleSelect
                      size="sm"
                      value={member.role}
                      options={options}
                      disabled={busyId === member.id}
                      onChange={(role) => changeRole(member, role)}
                      aria-label={t('roleOf', { member: label })}
                    />
                  ) : (
                    <RoleBadge role={member.role} />
                  )}
                </TableCell>
                <TableCell className="text-right">
                  {canRemove && manageable(member) && !lastOwner && (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={t('actionsFor', { member: label })}
                        >
                          <MoreHorizontal />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem
                          variant="destructive"
                          onSelect={() => setRemoving(member)}
                        >
                          <UserMinus /> {t('remove')}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                </TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={t('confirmRemoveTitle', { member: removing?.name || removing?.email || '' })}
        description={t('confirmRemoveDescription', { organization: orgSlug })}
        confirmLabel={t('confirmRemove')}
        destructive
        onConfirm={() => (removing ? remove(removing) : undefined)}
      />
    </div>
  )
}
