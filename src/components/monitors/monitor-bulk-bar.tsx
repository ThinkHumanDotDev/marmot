'use client'

import { BellMinus, BellPlus, Pause, Play, Tag, Tags, Trash2, X, Zap } from 'lucide-react'
import { useTranslations } from 'next-intl'
import * as React from 'react'
import { toast } from 'sonner'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { afterDialogsClose } from '@/components/shell/after-dialogs'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { api } from '@/lib/api'
import type { BulkResponse, MonitorBulkAction } from '@/lib/monitor-bulk'
import { toStoreMonitor } from '@/lib/realtime'
import { useMonitorSelection } from '@/stores/monitor-selection-store'
import { useMonitorStore } from '@/stores/monitor-store'

import type { FilterOption } from './monitor-list-toolbar'

export interface BulkPermissions {
  /** `monitor:update`: pause, resume, check, tags, channels. */
  update: boolean
  /** `monitor:delete`. */
  delete: boolean
}

interface MonitorBulkBarProps {
  orgId: string
  /** Selected monitors, in list order (always a subset of the shown ones). */
  selectedIds: readonly string[]
  /** Ids of the shown monitors, for "select all". */
  shownIds: readonly string[]
  permissions: BulkPermissions
  tags: FilterOption[]
  /** `null` when the user cannot read notification channels. */
  notifications: FilterOption[] | null
}

type BulkPayload = { tags?: { tag: string }[]; notifications?: string[] }

/** Apply the results to the live store, so the list is right even without a socket. */
function applyResults(response: BulkResponse) {
  const store = useMonitorStore.getState()
  for (const result of response.results) {
    if (!result.ok) continue
    if (response.action === 'delete') store.removeMonitor(result.id)
    else if (result.monitor) store.upsertMonitor(toStoreMonitor(result.monitor))
  }
}

/**
 * Select-all checkbox and the bulk actions on the selection (#124): pause, resume, check now,
 * add/remove tags, attach/detach channels and delete (confirmed). Each action is one request to
 * `POST /api/orgs/:orgId/monitors/bulk`; the result per monitor comes back in the response and
 * over the socket. Also runs the bulk actions the command palette asks for.
 */
export function MonitorBulkBar({
  orgId,
  selectedIds,
  shownIds,
  permissions,
  tags,
  notifications,
}: MonitorBulkBarProps) {
  const t = useTranslations('monitors.list.bulk')
  const tSel = useTranslations('monitors.list.selection')
  const setMany = useMonitorSelection((s) => s.setMany)
  const clear = useMonitorSelection((s) => s.clear)
  const [pending, setPending] = React.useState<MonitorBulkAction | null>(null)
  const [confirmDelete, setConfirmDelete] = React.useState(false)
  const selectAllRef = React.useRef<HTMLInputElement>(null)

  const count = selectedIds.length
  const allSelected = shownIds.length > 0 && count === shownIds.length
  const someSelected = count > 0 && !allSelected

  React.useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = someSelected
  }, [someSelected])

  const run = React.useCallback(
    async (action: MonitorBulkAction, payload?: BulkPayload) => {
      const ids = [...selectedIds]
      if (ids.length === 0) return
      setPending(action)
      try {
        const response = await api.post<BulkResponse>(`/api/orgs/${orgId}/monitors/bulk`, {
          body: { ids, action, ...(payload ? { payload } : {}) },
        })
        applyResults(response)
        const { changed, unchanged, failed } = response.summary
        const firstFailure = response.results.find((result) => !result.ok)
        if (failed > 0 && firstFailure && !firstFailure.ok) {
          toast.error(t('partial', { failed, message: firstFailure.message }), {
            description: t('result', { action, changed, unchanged }),
          })
        } else {
          toast.success(t('result', { action, changed, unchanged }))
        }
        clear()
      } catch (error) {
        toast.error(error instanceof Error ? error.message : t('failed'))
      } finally {
        setPending(null)
      }
    },
    [orgId, selectedIds, clear, t],
  )

  // Bulk actions started from the command palette: a store subscription (not render state), so
  // each request is taken exactly once.
  const latest = React.useRef({ run, count, permissions })
  React.useEffect(() => {
    latest.current = { run, count, permissions }
  })
  React.useEffect(() => {
    let cancelConfirm: () => void = () => undefined
    const unsubscribe = useMonitorSelection.subscribe((state, previous) => {
      if (!state.bulkRequest || state.bulkRequest === previous.bulkRequest) return
      const action = useMonitorSelection.getState().takeBulkRequest()
      const { run: runAction, count: selected, permissions: allowed } = latest.current
      if (!action || selected === 0) return
      if (action === 'delete') {
        // Opened once the palette has closed, so the two dialogs do not fight over the focus.
        if (allowed.delete) {
          cancelConfirm()
          cancelConfirm = afterDialogsClose(() => setConfirmDelete(true))
        }
      } else if (allowed.update) {
        void runAction(action)
      }
    })
    return () => {
      unsubscribe()
      cancelConfirm()
    }
  }, [])

  const busy = pending !== null

  return (
    <div
      className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b px-4 py-2"
      data-testid="monitor-bulk-bar"
    >
      <input
        ref={selectAllRef}
        type="checkbox"
        className="size-4 cursor-pointer accent-primary"
        checked={allSelected}
        disabled={shownIds.length === 0}
        aria-label={tSel('selectAll')}
        onChange={() => (allSelected ? clear() : setMany(shownIds, true))}
      />
      <span className="text-xs font-medium text-muted-foreground" aria-live="polite">
        {count > 0 ? tSel('selected', { count }) : tSel('none')}
      </span>
      {count > 0 && (
        <div role="toolbar" aria-label={t('label')} className="flex flex-wrap items-center gap-1.5">
          {permissions.update && (
            <>
              <Button size="xs" variant="outline" disabled={busy} onClick={() => void run('pause')}>
                <Pause aria-hidden /> {t('pause')}
              </Button>
              <Button
                size="xs"
                variant="outline"
                disabled={busy}
                onClick={() => void run('resume')}
              >
                <Play aria-hidden /> {t('resume')}
              </Button>
              <Button size="xs" variant="outline" disabled={busy} onClick={() => void run('check')}>
                <Zap aria-hidden /> {t('check')}
              </Button>
              {tags.length > 0 && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button size="xs" variant="outline" disabled={busy}>
                      <Tags aria-hidden /> {t('tags')}
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start">
                    <ReferenceSubmenu
                      label={t('addTag')}
                      icon={<Tag aria-hidden />}
                      options={tags}
                      onPick={(value) => void run('addTags', { tags: [{ tag: value }] })}
                    />
                    <ReferenceSubmenu
                      label={t('removeTag')}
                      icon={<X aria-hidden />}
                      options={tags}
                      onPick={(value) => void run('removeTags', { tags: [{ tag: value }] })}
                    />
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
              {notifications && notifications.length > 0 && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button size="xs" variant="outline" disabled={busy}>
                      <BellPlus aria-hidden /> {t('channels')}
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start">
                    <ReferenceSubmenu
                      label={t('attachChannel')}
                      icon={<BellPlus aria-hidden />}
                      options={notifications}
                      onPick={(value) => void run('addNotifications', { notifications: [value] })}
                    />
                    <ReferenceSubmenu
                      label={t('detachChannel')}
                      icon={<BellMinus aria-hidden />}
                      options={notifications}
                      onPick={(value) =>
                        void run('removeNotifications', { notifications: [value] })
                      }
                    />
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </>
          )}
          {permissions.delete && (
            <Button
              size="xs"
              variant="outline"
              className="text-destructive"
              disabled={busy}
              onClick={() => setConfirmDelete(true)}
            >
              <Trash2 aria-hidden /> {t('delete')}
            </Button>
          )}
          <Button size="xs" variant="ghost" disabled={busy} onClick={clear}>
            {tSel('clear')}
          </Button>
          {busy && (
            <span className="text-xs text-muted-foreground" role="status">
              {t('working')}
            </span>
          )}
        </div>
      )}
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={t('deleteTitle', { count })}
        description={t('deleteDescription')}
        confirmLabel={t('confirmDelete')}
        destructive
        onConfirm={async () => {
          await run('delete')
          setConfirmDelete(false)
        }}
      />
    </div>
  )
}

function ReferenceSubmenu({
  label,
  icon,
  options,
  onPick,
}: {
  label: string
  icon: React.ReactNode
  options: FilterOption[]
  onPick: (value: string) => void
}) {
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        {icon}
        {label}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="max-h-72 overflow-y-auto">
        {options.map((option) => (
          <DropdownMenuItem key={option.value} onSelect={() => onPick(option.value)}>
            {option.color && (
              <span
                aria-hidden
                className="size-2.5 shrink-0 rounded-full"
                style={{ backgroundColor: option.color }}
              />
            )}
            <span className="truncate">{option.label}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}
