'use client'

import {
  Activity,
  AlertTriangle,
  Bell,
  MoreHorizontal,
  Pencil,
  Plus,
  Send,
  Trash2,
} from 'lucide-react'
import { useFormatter, useLocale, useTranslations } from 'next-intl'
import * as React from 'react'
import { toast } from 'sonner'

import { EmptyState } from '@/components/empty-state'
import { PageHeader } from '@/components/page-header'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Switch } from '@/components/ui/switch'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ApiError } from '@/lib/api'
import { cn } from '@/lib/utils'

import { ChannelDialog } from './channel-dialog'
import { ChannelMonitorsDialog } from './channel-monitors-dialog'
import {
  notificationsApi,
  type NotificationProviderDescriptor,
  type NotificationRow,
} from './types'

interface NotificationsViewProps {
  orgId: string
  initial: NotificationRow[]
  providers: NotificationProviderDescriptor[]
  /** `notification:update` — create, edit, test, toggle, delete. */
  canManage: boolean
  /** Why this user may not turn on the server SMTP settings for a channel, or `null` when they may. */
  serverSmtpRestriction: string | null
  /** Organization time zone the "last sent" timestamps render in. */
  timeZone: string
}

/** "Last sent" as a compact relative time (`5 min ago`). */
function useRelativeTime() {
  const t = useTranslations('notifications.lastSent')
  return (iso: string) => {
    const diff = Date.now() - new Date(iso).getTime()
    const minutes = Math.round(diff / 60_000)
    if (minutes < 1) return t('justNow')
    if (minutes < 60) return t('minutes', { count: minutes })
    const hours = Math.round(minutes / 60)
    if (hours < 48) return t('hours', { count: hours })
    return t('days', { count: Math.round(hours / 24) })
  }
}

export function NotificationsView({
  orgId,
  initial,
  providers,
  canManage,
  serverSmtpRestriction,
  timeZone,
}: NotificationsViewProps) {
  const t = useTranslations('notifications')
  const locale = useLocale()
  const format = useFormatter()
  const relativeTime = useRelativeTime()
  const [rows, setRows] = React.useState<NotificationRow[]>(initial)
  const [dialogOpen, setDialogOpen] = React.useState(false)
  const [editing, setEditing] = React.useState<NotificationRow | null>(null)
  const [deleting, setDeleting] = React.useState<NotificationRow | null>(null)
  const [busyId, setBusyId] = React.useState<string | null>(null)
  const [monitorsOf, setMonitorsOf] = React.useState<NotificationRow | null>(null)
  const tMonitors = useTranslations('notifications.monitors')
  const closeMonitors = React.useCallback((open: boolean) => {
    if (!open) setMonitorsOf(null)
  }, [])

  const providerLabel = React.useCallback(
    (type: string) => providers.find((p) => p.name === type),
    [providers],
  )

  const upsert = (row: NotificationRow) =>
    setRows((current) => {
      const next = current.some((r) => r.id === row.id)
        ? current.map((r) => (r.id === row.id ? row : r))
        : [...current, row]
      return next.sort((a, b) => a.name.localeCompare(b.name, locale))
    })

  function openCreate() {
    setEditing(null)
    setDialogOpen(true)
  }

  function openEdit(row: NotificationRow) {
    setEditing(row)
    setDialogOpen(true)
  }

  async function toggleActive(row: NotificationRow, active: boolean) {
    // Optimistic: flip the switch right away, restore the previous row if the update fails.
    setBusyId(row.id)
    upsert({ ...row, active })
    try {
      upsert(await notificationsApi.update(orgId, row.id, { active }))
      toast.success(active ? t('list.enabled') : t('list.paused'))
    } catch (error) {
      upsert(row)
      toast.error(error instanceof Error ? error.message : t('list.updateFailed'))
    } finally {
      setBusyId(null)
    }
  }

  async function sendTest(row: NotificationRow) {
    setBusyId(row.id)
    try {
      const result = await notificationsApi.test(orgId, { notificationId: row.id })
      toast.success(t('test.sent'), { description: result.result })
    } catch (error) {
      const details = error instanceof ApiError ? (error.details as { error?: string }) : null
      toast.error(t('test.failed'), {
        description: details?.error ?? (error instanceof Error ? error.message : undefined),
      })
    } finally {
      setBusyId(null)
    }
  }

  async function confirmDelete() {
    if (!deleting) return
    setBusyId(deleting.id)
    try {
      await notificationsApi.remove(orgId, deleting.id)
      setRows((current) => current.filter((r) => r.id !== deleting.id))
      toast.success(t('list.deleted'))
      setDeleting(null)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('list.deleteFailed'))
    } finally {
      setBusyId(null)
    }
  }

  return (
    <>
      <PageHeader
        title={t('page.title')}
        description={t('page.description')}
        actions={
          canManage ? (
            <Button onClick={openCreate}>
              <Plus /> {t('list.new')}
            </Button>
          ) : undefined
        }
      />
      <section className="p-4 sm:p-6 md:p-8">
        {rows.length === 0 ? (
          <EmptyState
            icon={Bell}
            title={t('list.emptyTitle')}
            description={t('list.emptyDescription')}
            action={
              canManage ? (
                <Button onClick={openCreate}>
                  <Plus /> {t('list.new')}
                </Button>
              ) : undefined
            }
          />
        ) : (
          <div className="rounded-xl border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('list.columns.name')}</TableHead>
                  <TableHead>{t('list.columns.provider')}</TableHead>
                  <TableHead className="hidden sm:table-cell">
                    {t('list.columns.lastSent')}
                  </TableHead>
                  <TableHead className="w-24">{t('list.columns.active')}</TableHead>
                  {canManage && (
                    <TableHead className="w-12">
                      <span className="sr-only">{t('list.columns.actions')}</span>
                    </TableHead>
                  )}
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => {
                  const descriptor = providerLabel(row.type)
                  const busy = busyId === row.id
                  return (
                    <TableRow key={row.id} className={cn(!row.active && 'text-muted-foreground')}>
                      <TableCell className="font-medium">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="truncate">{row.name}</span>
                          {row.isDefault && <Badge variant="secondary">{t('list.default')}</Badge>}
                          {row.lastError && (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Badge variant="destructive" className="gap-1">
                                  <AlertTriangle aria-hidden /> {t('list.error')}
                                </Badge>
                              </TooltipTrigger>
                              <TooltipContent className="max-w-sm break-words">
                                {row.lastError}
                              </TooltipContent>
                            </Tooltip>
                          )}
                        </div>
                      </TableCell>
                      <TableCell>
                        <span>{descriptor?.label ?? row.type}</span>
                        {descriptor && (
                          <span className="ml-2 hidden text-xs text-muted-foreground md:inline">
                            {t(`groups.${descriptor.group}`)}
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="hidden text-muted-foreground sm:table-cell">
                        {row.lastSentAt ? (
                          <time
                            dateTime={row.lastSentAt}
                            title={format.dateTime(new Date(row.lastSentAt), 'short', { timeZone })}
                          >
                            {relativeTime(row.lastSentAt)}
                          </time>
                        ) : (
                          '—'
                        )}
                      </TableCell>
                      <TableCell>
                        <Switch
                          aria-label={t('list.activeLabel', { name: row.name })}
                          checked={row.active}
                          disabled={!canManage || busy}
                          onCheckedChange={(checked) => void toggleActive(row, checked)}
                        />
                      </TableCell>
                      {canManage && (
                        <TableCell>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                aria-label={t('list.actionsFor', { name: row.name })}
                                disabled={busy}
                              >
                                <MoreHorizontal />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem onSelect={() => openEdit(row)}>
                                <Pencil /> {t('list.edit')}
                              </DropdownMenuItem>
                              <DropdownMenuItem onSelect={() => setMonitorsOf(row)}>
                                <Activity /> {tMonitors('action')}
                              </DropdownMenuItem>
                              <DropdownMenuItem onSelect={() => void sendTest(row)}>
                                <Send /> {t('list.sendTest')}
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                variant="destructive"
                                onSelect={() => setDeleting(row)}
                              >
                                <Trash2 /> {t('list.delete')}
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </TableCell>
                      )}
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </section>

      {canManage && (
        <ChannelDialog
          orgId={orgId}
          providers={providers}
          serverSmtpRestriction={serverSmtpRestriction}
          channel={editing}
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          onSaved={upsert}
        />
      )}

      {canManage && (
        <ChannelMonitorsDialog orgId={orgId} channel={monitorsOf} onOpenChange={closeMonitors} />
      )}

      <Dialog open={deleting !== null} onOpenChange={(open) => !open && setDeleting(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {t('list.confirmDeleteTitle', { name: deleting?.name ?? '' })}
            </DialogTitle>
            <DialogDescription>{t('list.confirmDeleteDescription')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleting(null)}>
              {t('list.cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={() => void confirmDelete()}
              disabled={busyId !== null}
            >
              {t('list.confirmDelete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
