'use client'

import { MoreHorizontal, Pause, Pencil, Play, Plus, Trash2, Wrench } from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import * as React from 'react'
import { toast } from 'sonner'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { EmptyState } from '@/components/empty-state'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { getSocket } from '@/lib/socket'
import { MAINTENANCE_STRATEGY_LABELS } from '@/lib/validation/maintenance'
import { RealtimeEvents, type RealtimePayloads } from '@/server/realtime/events'

import { MaintenanceStatusBadge } from './maintenance-status-badge'
import { formatWindow, maintenanceApi, type MaintenanceSummary } from './types'

interface MaintenanceListProps {
  orgId: string | number
  orgSlug: string
  initial: MaintenanceSummary[]
  /** `maintenance:update` — pause/resume/edit. */
  canEdit: boolean
  /** `maintenance:delete` */
  canDelete: boolean
}

const message = (error: unknown, fallback: string) =>
  error instanceof Error && error.message ? error.message : fallback

/** One-line schedule description for the row. */
function scheduleText(item: MaintenanceSummary): string {
  switch (item.strategy) {
    case 'manual':
      return 'Manual — active until paused'
    case 'single':
      return item.current
        ? `Until ${new Date(item.current.end).toLocaleString()}`
        : item.next
          ? formatWindow(item.next)
          : 'Single window'
    case 'cron':
      return `Cron ${item.cron ?? ''} · ${item.duration} min`
    default: {
      const time = `${item.timeRange.start ?? ''}–${item.timeRange.end ?? ''}`
      if (item.strategy === 'recurring-interval') {
        return item.intervalDay === 1
          ? `Every day ${time}`
          : `Every ${item.intervalDay} days ${time}`
      }
      if (item.strategy === 'recurring-weekday') {
        const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
        return `${item.weekdays.map((d) => names[Number(d)] ?? d).join(', ')} ${time}`
      }
      return `Days ${item.daysOfMonth.map((d) => d.replace('lastDay', 'last-')).join(', ')} ${time}`
    }
  }
}

function windowText(item: MaintenanceSummary): string | null {
  if (item.status === 'under-maintenance' && item.current) {
    return `Ends ${new Date(item.current.end).toLocaleString()}`
  }
  if (item.status === 'scheduled' && item.next) return `Next ${formatWindow(item.next)}`
  return null
}

/**
 * Maintenance windows of the organization. Server-rendered with `initial`; the socket's
 * `maintenanceList` event (sent by the worker when a status flips and by the hooks after edits)
 * replaces the list live.
 */
export function MaintenanceList({
  orgId,
  orgSlug,
  initial,
  canEdit,
  canDelete,
}: MaintenanceListProps) {
  const router = useRouter()
  const [rows, setRows] = React.useState(initial)
  const [seed, setSeed] = React.useState(initial)
  const [busyId, setBusyId] = React.useState<string | null>(null)
  const [deleting, setDeleting] = React.useState<MaintenanceSummary | null>(null)

  // A fresh server render (router.refresh) replaces what the socket delivered so far.
  if (seed !== initial) {
    setSeed(initial)
    setRows(initial)
  }

  React.useEffect(() => {
    const socket = getSocket()
    const onList = (payload: RealtimePayloads['maintenanceList']) => {
      if (payload.organizationId === String(orgId)) {
        setRows(payload.items as MaintenanceSummary[])
      }
    }
    socket.on(RealtimeEvents.maintenanceList, onList)
    return () => {
      socket.off(RealtimeEvents.maintenanceList, onList)
    }
  }, [orgId])

  const replace = (item: MaintenanceSummary) =>
    setRows((current) => current.map((row) => (row.id === item.id ? item : row)))

  async function toggleActive(item: MaintenanceSummary) {
    setBusyId(item.id)
    try {
      const updated = item.active
        ? await maintenanceApi.pause(orgId, item.id)
        : await maintenanceApi.resume(orgId, item.id)
      replace(updated)
      toast.success(item.active ? 'Maintenance paused' : 'Maintenance resumed')
    } catch (error) {
      toast.error(message(error, 'Could not update the maintenance'))
    } finally {
      setBusyId(null)
    }
  }

  async function confirmDelete() {
    if (!deleting) return
    try {
      await maintenanceApi.remove(orgId, deleting.id)
      setRows((current) => current.filter((row) => row.id !== deleting.id))
      toast.success(`Deleted “${deleting.title}”`)
      setDeleting(null)
      router.refresh()
    } catch (error) {
      toast.error(message(error, 'Could not delete the maintenance'))
    }
  }

  if (rows.length === 0) {
    return (
      <EmptyState
        icon={Wrench}
        title="No maintenance scheduled"
        description="Schedule a window to silence alerts and inform your users ahead of time."
        action={
          canEdit ? (
            <Button asChild>
              <Link href={`/${orgSlug}/maintenance/new`}>
                <Plus /> Schedule maintenance
              </Link>
            </Button>
          ) : undefined
        }
      />
    )
  }

  return (
    <>
      <div className="overflow-hidden rounded-xl border bg-card">
        <div className="hidden grid-cols-[minmax(0,1fr)_minmax(0,16rem)_10rem_auto] items-center gap-x-3 border-b px-4 py-2 text-xs font-medium text-muted-foreground md:grid">
          <span>Maintenance</span>
          <span>Schedule</span>
          <span>Status</span>
          <span className="w-9" aria-hidden />
        </div>
        <ul className="divide-y" data-testid="maintenance-list">
          {rows.map((item) => {
            const when = windowText(item)
            return (
              <li
                key={item.id}
                data-maintenance-id={item.id}
                className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 px-4 py-3 md:grid-cols-[minmax(0,1fr)_minmax(0,16rem)_10rem_auto]"
              >
                <div className="min-w-0">
                  <Link
                    href={canEdit ? `/${orgSlug}/maintenance/${item.id}/edit` : '#'}
                    className="block truncate font-medium hover:underline"
                  >
                    {item.title}
                  </Link>
                  <p className="truncate text-xs text-muted-foreground">
                    {MAINTENANCE_STRATEGY_LABELS[item.strategy]}
                    {item.monitors.length > 0 &&
                      ` · ${item.monitors.length} monitor${item.monitors.length === 1 ? '' : 's'}`}
                    {item.statusPages.length > 0 &&
                      ` · ${item.statusPages.length} status page${item.statusPages.length === 1 ? '' : 's'}`}
                  </p>
                </div>
                <div className="col-span-2 min-w-0 text-xs text-muted-foreground md:col-span-1 md:text-sm">
                  <p className="truncate" suppressHydrationWarning>
                    {scheduleText(item)}
                  </p>
                  {when && (
                    <p className="truncate text-xs" suppressHydrationWarning>
                      {when}
                    </p>
                  )}
                </div>
                <div className="col-start-1 md:col-start-auto">
                  <MaintenanceStatusBadge status={item.status} />
                </div>
                {canEdit || canDelete ? (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Actions for ${item.title}`}
                        disabled={busyId === item.id}
                        className="col-start-2 row-start-1 md:col-start-auto md:row-start-auto"
                      >
                        <MoreHorizontal />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      {canEdit && (
                        <DropdownMenuItem asChild>
                          <Link href={`/${orgSlug}/maintenance/${item.id}/edit`}>
                            <Pencil /> Edit
                          </Link>
                        </DropdownMenuItem>
                      )}
                      {canEdit && (
                        <DropdownMenuItem onSelect={() => void toggleActive(item)}>
                          {item.active ? (
                            <>
                              <Pause /> Pause
                            </>
                          ) : (
                            <>
                              <Play /> Resume
                            </>
                          )}
                        </DropdownMenuItem>
                      )}
                      {canDelete && (
                        <>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            variant="destructive"
                            onSelect={() => setDeleting(item)}
                          >
                            <Trash2 /> Delete
                          </DropdownMenuItem>
                        </>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                ) : (
                  <span className="hidden w-9 md:block" aria-hidden />
                )}
              </li>
            )
          })}
        </ul>
      </div>

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`Delete “${deleting?.title ?? ''}”?`}
        description="Affected monitors resume normal checks on their next run and status pages stop announcing it."
        confirmLabel="Delete"
        destructive
        onConfirm={confirmDelete}
      />
    </>
  )
}
