'use client'

import { MoreHorizontal, Pause, Pencil, Play, Plus, Trash2, Wrench } from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useFormatter, useTranslations } from 'next-intl'
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
import { timeZoneOrDefault } from '@/i18n/formats'
import { getSocket } from '@/lib/socket'
import { WEEKDAY_VALUES, type WeekdayValue } from '@/lib/validation/maintenance'
import { RealtimeEvents, type RealtimePayloads } from '@/server/realtime/events'

import { MaintenanceStatusBadge } from './maintenance-status-badge'
import { maintenanceApi, type MaintenanceSummary } from './types'

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

/** One-line schedule and window descriptions for the rows, in each window's own time zone. */
function useScheduleText() {
  const t = useTranslations('maintenance.schedule')
  const tw = useTranslations('maintenance.weekdays')
  const format = useFormatter()

  const instant = (iso: string, timeZone: string) =>
    format.dateTime(new Date(iso), 'zoned', { timeZone })
  const range = (window: { start: string; end: string }, timeZone: string) =>
    format.dateTimeRange(new Date(window.start), new Date(window.end), 'zoned', { timeZone })

  function schedule(item: MaintenanceSummary): string {
    const zone = timeZoneOrDefault(item.resolvedTimezone)
    switch (item.strategy) {
      case 'manual':
        return t('manual')
      case 'single':
        return item.current
          ? t('until', { time: instant(item.current.end, zone) })
          : item.next
            ? range(item.next, zone)
            : t('single')
      case 'cron':
        return t('cron', { cron: item.cron ?? '', duration: item.duration })
      default: {
        const time = `${item.timeRange.start ?? ''}–${item.timeRange.end ?? ''}`
        if (item.strategy === 'recurring-interval') {
          return item.intervalDay === 1
            ? t('everyDay', { time })
            : t('everyNDays', { days: item.intervalDay, time })
        }
        if (item.strategy === 'recurring-weekday') {
          const days = format.list(
            item.weekdays.map((d) => (isWeekday(d) ? tw(d) : d)),
            { type: 'unit', style: 'short' },
          )
          return t('weekdays', { days, time })
        }
        const days = format.list(
          item.daysOfMonth.map((d) =>
            d.startsWith('lastDay') ? t('lastDay', { n: d.slice('lastDay'.length) }) : d,
          ),
          { type: 'unit', style: 'short' },
        )
        return t('daysOfMonth', { days, time })
      }
    }
  }

  function windowOf(item: MaintenanceSummary): string | null {
    const zone = timeZoneOrDefault(item.resolvedTimezone)
    if (item.status === 'under-maintenance' && item.current) {
      return t('ends', { time: instant(item.current.end, zone) })
    }
    if (item.status === 'scheduled' && item.next) {
      return t('next', { window: range(item.next, zone) })
    }
    return null
  }

  return { schedule, windowOf }
}

const isWeekday = (value: string): value is WeekdayValue =>
  (WEEKDAY_VALUES as readonly string[]).includes(value)

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
  const t = useTranslations('maintenance.list')
  const ts = useTranslations('maintenance.strategies')
  const text = useScheduleText()
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
      toast.success(item.active ? t('paused') : t('resumed'))
    } catch (error) {
      toast.error(message(error, t('updateFailed')))
    } finally {
      setBusyId(null)
    }
  }

  async function confirmDelete() {
    if (!deleting) return
    try {
      await maintenanceApi.remove(orgId, deleting.id)
      setRows((current) => current.filter((row) => row.id !== deleting.id))
      toast.success(t('deleted', { title: deleting.title }))
      setDeleting(null)
      router.refresh()
    } catch (error) {
      toast.error(message(error, t('deleteFailed')))
    }
  }

  if (rows.length === 0) {
    return (
      <EmptyState
        icon={Wrench}
        title={t('emptyTitle')}
        description={t('emptyDescription')}
        action={
          canEdit ? (
            <Button asChild>
              <Link href={`/${orgSlug}/maintenance/new`}>
                <Plus /> {t('schedule')}
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
          <span>{t('columns.maintenance')}</span>
          <span>{t('columns.schedule')}</span>
          <span>{t('columns.status')}</span>
          <span className="w-9" aria-hidden />
        </div>
        <ul className="divide-y" data-testid="maintenance-list">
          {rows.map((item) => {
            const when = text.windowOf(item)
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
                    {ts(item.strategy)}
                    {item.monitors.length > 0 && t('monitorCount', { count: item.monitors.length })}
                    {item.statusPages.length > 0 &&
                      t('statusPageCount', { count: item.statusPages.length })}
                  </p>
                </div>
                <div className="col-span-2 min-w-0 text-xs text-muted-foreground md:col-span-1 md:text-sm">
                  <p className="truncate" suppressHydrationWarning>
                    {text.schedule(item)}
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
                        aria-label={t('actionsFor', { title: item.title })}
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
                            <Pencil /> {t('edit')}
                          </Link>
                        </DropdownMenuItem>
                      )}
                      {canEdit && (
                        <DropdownMenuItem onSelect={() => void toggleActive(item)}>
                          {item.active ? (
                            <>
                              <Pause /> {t('pause')}
                            </>
                          ) : (
                            <>
                              <Play /> {t('resume')}
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
                            <Trash2 /> {t('delete')}
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
        title={t('confirmDeleteTitle', { title: deleting?.title ?? '' })}
        description={t('confirmDeleteDescription')}
        confirmLabel={t('confirmDelete')}
        destructive
        onConfirm={confirmDelete}
      />
    </>
  )
}
