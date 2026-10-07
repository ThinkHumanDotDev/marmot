'use client'

import { ArrowRightLeft, LogOut, Trash2 } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
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
  const t = useTranslations('settings.organization.danger')
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
      toast.success(
        t('transferred', {
          member: target?.name || target?.email || t('theMember'),
          organization: org.name,
        }),
      )
      setDialog(null)
      router.refresh()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('transferFailed'))
    }
  }

  async function leave() {
    try {
      await orgApi.removeMember(org.id, currentUserId)
      toast.success(t('left', { organization: org.name }))
      router.replace('/')
      router.refresh()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('leaveFailed'))
    }
  }

  async function remove() {
    try {
      await orgApi.remove(org.id)
      toast.success(t('deleted', { organization: org.name }))
      router.replace('/')
      router.refresh()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('deleteFailed'))
    }
  }

  return (
    <Card className="border-destructive/40">
      <CardHeader>
        <CardTitle className="text-destructive">{t('title')}</CardTitle>
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>
      <CardContent className="divide-y">
        {isOwner && (
          <Row title={t('transferTitle')} description={t('transferDescription')}>
            <Button
              variant="outline"
              onClick={() => setDialog('transfer')}
              disabled={candidates.length === 0}
            >
              <ArrowRightLeft /> {t('transfer')}
            </Button>
          </Row>
        )}
        {isMember && (
          <Row
            title={t('leaveTitle')}
            description={lastOwner ? t('leaveLastOwner') : t('leaveDescription')}
          >
            <Button variant="outline" onClick={() => setDialog('leave')} disabled={lastOwner}>
              <LogOut /> {t('leave')}
            </Button>
          </Row>
        )}
        {isOwner && (
          <Row title={t('deleteTitle')} description={t('deleteDescription')}>
            <Button variant="destructive" onClick={() => setDialog('delete')}>
              <Trash2 /> {t('delete')}
            </Button>
          </Row>
        )}
        {!isOwner && !isMember && <p className="text-sm text-muted-foreground">{t('nothing')}</p>}
      </CardContent>

      <ConfirmDialog
        open={dialog === 'transfer'}
        onOpenChange={(open) => !open && setDialog(null)}
        title={t('transferConfirmTitle', { organization: org.name })}
        description={t('transferConfirmDescription')}
        confirmLabel={t('transferTitle')}
        onConfirm={transfer}
      >
        <div className="grid gap-2">
          <Label>{t('newOwner')}</Label>
          <Select value={transferTo} onValueChange={setTransferTo}>
            <SelectTrigger className="w-full" aria-label={t('newOwner')}>
              <SelectValue placeholder={t('chooseMember')} />
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
        title={t('leaveConfirmTitle', { organization: org.name })}
        description={t('leaveConfirmDescription')}
        confirmLabel={t('leaveTitle')}
        destructive
        onConfirm={leave}
      />

      <ConfirmDialog
        open={dialog === 'delete'}
        onOpenChange={(open) => !open && setDialog(null)}
        title={t('deleteConfirmTitle', { organization: org.name })}
        description={t('deleteConfirmDescription')}
        confirmText={org.slug}
        confirmLabel={t('deleteTitle')}
        destructive
        onConfirm={remove}
      />
    </Card>
  )
}
