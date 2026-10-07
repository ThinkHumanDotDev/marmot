'use client'

import { Copy, Loader2, MoreHorizontal, Pause, Pencil, Play, Trash2 } from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import * as React from 'react'
import { toast } from 'sonner'

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
import { api, ApiError } from '@/lib/api'
import { supportsCheckNow } from '@/lib/on-demand-check'
import { useMonitorStore } from '@/stores/monitor-store'

import { CheckNowButton } from './check-now'

export interface MonitorActionsProps {
  orgId: string | number
  orgSlug: string
  monitor: { id: string | number; name: string; active: boolean; type?: string }
  /** Hide write actions for viewers. */
  canEdit: boolean
  canDelete: boolean
}

const message = (error: unknown, fallback: string) =>
  error instanceof ApiError || error instanceof Error ? error.message : fallback

/**
 * Detail-page header actions: check now, pause/resume, edit, clone and delete (with confirmation).
 * Mutations go through the org-scoped route handlers with the user's cookie, then the server
 * component tree is refreshed so the page reflects the stored document.
 */
export function MonitorActions({
  orgId,
  orgSlug,
  monitor,
  canEdit,
  canDelete,
}: MonitorActionsProps) {
  const t = useTranslations('monitors.actions')
  const router = useRouter()
  const [busy, setBusy] = React.useState<null | 'clone' | 'delete'>(null)
  const [confirmDelete, setConfirmDelete] = React.useState(false)
  const base = `/api/orgs/${orgId}/monitors/${monitor.id}`

  // Optimistic pause/resume: the button flips at once and falls back to the stored value if the
  // request fails (useOptimistic reverts when the transition ends without a new prop).
  const [active, setOptimisticActive] = React.useOptimistic(monitor.active)
  const [toggling, startToggle] = React.useTransition()

  function toggleActive() {
    const next = !active
    startToggle(async () => {
      setOptimisticActive(next)
      const store = useMonitorStore.getState()
      const live = store.monitors[String(monitor.id)]
      if (live) store.upsertMonitor({ ...live, active: next })
      try {
        await api.post(`${base}/${next ? 'resume' : 'pause'}`)
        toast.success(next ? t('resumed') : t('paused'))
        router.refresh()
      } catch (error) {
        if (live) useMonitorStore.getState().upsertMonitor(live)
        toast.error(message(error, t('updateFailed')))
      }
    })
  }

  async function clone() {
    setBusy('clone')
    try {
      const doc = await api.post<{ id: string | number }>(`${base}/clone`)
      toast.success(t('cloned'))
      router.push(`/${orgSlug}/monitors/${doc.id}/edit`)
    } catch (error) {
      toast.error(message(error, t('cloneFailed')))
      setBusy(null)
    }
  }

  async function remove() {
    setBusy('delete')
    try {
      await api.delete(base)
      toast.success(t('deleted', { name: monitor.name }))
      router.push(`/${orgSlug}/monitors`)
      router.refresh()
    } catch (error) {
      toast.error(message(error, t('deleteFailed')))
      setBusy(null)
      setConfirmDelete(false)
    }
  }

  if (!canEdit && !canDelete) return null

  return (
    <>
      {canEdit && active && supportsCheckNow(monitor.type) && (
        <CheckNowButton orgId={orgId} monitor={monitor} />
      )}
      {canEdit && (
        <Button
          variant="outline"
          onClick={toggleActive}
          disabled={busy !== null || toggling}
          data-testid="toggle-active"
        >
          {active ? <Pause aria-hidden /> : <Play aria-hidden />}
          {active ? t('pause') : t('resume')}
        </Button>
      )}
      {canEdit && (
        <Button asChild>
          <Link href={`/${orgSlug}/monitors/${monitor.id}/edit`}>
            <Pencil /> {t('edit')}
          </Link>
        </Button>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="icon" aria-label={t('more')} disabled={busy !== null}>
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {canEdit && (
            <DropdownMenuItem onSelect={clone}>
              <Copy /> {t('clone')}
            </DropdownMenuItem>
          )}
          {canEdit && canDelete && <DropdownMenuSeparator />}
          {canDelete && (
            <DropdownMenuItem variant="destructive" onSelect={() => setConfirmDelete(true)}>
              <Trash2 /> {t('delete')}
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={confirmDelete} onOpenChange={(open) => busy === null && setConfirmDelete(open)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('deleteTitle', { name: monitor.name })}</DialogTitle>
            <DialogDescription>{t('deleteDescription')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setConfirmDelete(false)}
              disabled={busy === 'delete'}
            >
              {t('cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={remove}
              disabled={busy === 'delete'}
              data-testid="confirm-delete"
            >
              {busy === 'delete' && <Loader2 className="animate-spin" />}
              {t('confirmDelete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
