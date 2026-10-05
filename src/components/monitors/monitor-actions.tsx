'use client'

import { Copy, Loader2, MoreHorizontal, Pause, Pencil, Play, Trash2 } from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
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

export interface MonitorActionsProps {
  orgId: string | number
  orgSlug: string
  monitor: { id: string | number; name: string; active: boolean }
  /** Hide write actions for viewers. */
  canEdit: boolean
  canDelete: boolean
}

const message = (error: unknown, fallback: string) =>
  error instanceof ApiError || error instanceof Error ? error.message : fallback

/**
 * Detail-page header actions: pause/resume, edit, clone and delete (with confirmation).
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
  const router = useRouter()
  const [busy, setBusy] = React.useState<null | 'toggle' | 'clone' | 'delete'>(null)
  const [confirmDelete, setConfirmDelete] = React.useState(false)
  const base = `/api/orgs/${orgId}/monitors/${monitor.id}`

  async function toggleActive() {
    setBusy('toggle')
    try {
      await api.post(`${base}/${monitor.active ? 'pause' : 'resume'}`)
      toast.success(monitor.active ? 'Monitor paused' : 'Monitor resumed')
      router.refresh()
    } catch (error) {
      toast.error(message(error, 'Could not update the monitor'))
    } finally {
      setBusy(null)
    }
  }

  async function clone() {
    setBusy('clone')
    try {
      const doc = await api.post<{ id: string | number }>(`${base}/clone`)
      toast.success('Monitor cloned (paused)')
      router.push(`/${orgSlug}/monitors/${doc.id}/edit`)
    } catch (error) {
      toast.error(message(error, 'Could not clone the monitor'))
      setBusy(null)
    }
  }

  async function remove() {
    setBusy('delete')
    try {
      await api.delete(base)
      toast.success(`Deleted “${monitor.name}”`)
      router.push(`/${orgSlug}/monitors`)
      router.refresh()
    } catch (error) {
      toast.error(message(error, 'Could not delete the monitor'))
      setBusy(null)
      setConfirmDelete(false)
    }
  }

  if (!canEdit && !canDelete) return null

  return (
    <>
      {canEdit && (
        <Button
          variant="outline"
          onClick={toggleActive}
          disabled={busy !== null}
          data-testid="toggle-active"
        >
          {busy === 'toggle' ? (
            <Loader2 className="animate-spin" />
          ) : monitor.active ? (
            <Pause />
          ) : (
            <Play />
          )}
          {monitor.active ? 'Pause' : 'Resume'}
        </Button>
      )}
      {canEdit && (
        <Button asChild>
          <Link href={`/${orgSlug}/monitors/${monitor.id}/edit`}>
            <Pencil /> Edit
          </Link>
        </Button>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="icon" aria-label="More actions" disabled={busy !== null}>
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {canEdit && (
            <DropdownMenuItem onSelect={clone}>
              <Copy /> Clone
            </DropdownMenuItem>
          )}
          {canEdit && canDelete && <DropdownMenuSeparator />}
          {canDelete && (
            <DropdownMenuItem variant="destructive" onSelect={() => setConfirmDelete(true)}>
              <Trash2 /> Delete
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={confirmDelete} onOpenChange={(open) => busy === null && setConfirmDelete(open)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete “{monitor.name}”?</DialogTitle>
            <DialogDescription>
              This removes the monitor together with its heartbeats and statistics. Child monitors
              of a group are kept and detached. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setConfirmDelete(false)}
              disabled={busy === 'delete'}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={remove}
              disabled={busy === 'delete'}
              data-testid="confirm-delete"
            >
              {busy === 'delete' && <Loader2 className="animate-spin" />}
              Delete monitor
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
