'use client'

import { Activity, Plus, Radio, SearchX, WifiOff } from 'lucide-react'
import Link from 'next/link'
import { useLocale, useTranslations } from 'next-intl'
import * as React from 'react'
import { useShallow } from 'zustand/react/shallow'

import { EmptyState } from '@/components/empty-state'
import { useRealtimeConnection } from '@/components/realtime/socket-provider'
import { afterDialogsClose } from '@/components/shell/after-dialogs'
import { Button } from '@/components/ui/button'
import {
  EMPTY_FILTERS,
  matchesMonitorFilters,
  parseSearchQuery,
  serializeMonitorFilters,
  STATUS_FILTERS,
  type LiveStatus,
  type MonitorFilters,
} from '@/lib/monitor-filters'
import { LOCAL_LOCATION } from '@/lib/probe-locations'
import { toStoreHeartbeat, toStoreMonitor } from '@/lib/realtime'
import { cn } from '@/lib/utils'
import type { OrgRealtimeState } from '@/server/realtime/state'
import { useMonitorSelection } from '@/stores/monitor-selection-store'
import {
  selectMonitorList,
  statusKey,
  useMonitorStore,
  type MonitorSummary,
} from '@/stores/monitor-store'

import { MonitorBulkBar, type BulkPermissions } from './monitor-bulk-bar'
import { MonitorListToolbar, type FilterOption, type FilterOptions } from './monitor-list-toolbar'
import {
  MonitorRow,
  MonitorRowView,
  ROW_CHECKBOX_ATTR,
  type RowNavigateHandler,
  type RowSelectHandler,
} from './monitor-row'
import { UPTIME_BAR_BEATS } from './uptime-bar'

/** Serialisable initial state produced by `loadOrgState` on the server. */
export type MonitorListInitialState = Pick<
  OrgRealtimeState,
  'organizationId' | 'monitors' | 'heartbeats' | 'uptime'
>

/** Organization resources the filters and bulk actions offer (loaded by the page). */
export interface MonitorListResources {
  tags: { id: string; name: string; color: string | null }[]
  /** `null` when the user may not read notification channels. */
  notifications: { id: string; name: string }[] | null
  locations: { id: string; name: string }[]
}

interface MonitorListProps {
  orgSlug: string
  initial: MonitorListInitialState
  /** `monitor:create`; viewers get the empty state without the call to action. */
  canCreate?: boolean
  /** Filters parsed from the URL on the server, so the first render is already filtered. */
  initialFilters?: MonitorFilters
  resources?: MonitorListResources
  /** Bulk actions the user may run; without any, rows have no checkboxes. */
  bulk?: BulkPermissions
}

/** Write the server-rendered state into the store (runs once per organization). */
function hydrateStore(initial: MonitorListInitialState) {
  const store = useMonitorStore.getState()
  store.setMonitors(initial.monitors.map(toStoreMonitor))
  for (const monitor of initial.monitors) {
    const beats = initial.heartbeats[monitor.id]
    if (beats) store.setHeartbeatList(monitor.id, beats.map(toStoreHeartbeat))
    const uptime = initial.uptime[monitor.id]?.['24h']
    if (uptime !== undefined) store.setUptime(monitor.id, '24h', uptime)
  }
}

/** Live status of every monitor; re-renders only when one of them changes. */
function useLiveStatuses(): Record<string, LiveStatus> {
  return useMonitorStore(
    useShallow((s) => {
      const out: Record<string, LiveStatus> = {}
      for (const id of Object.keys(s.monitors))
        out[id] = statusKey(s.heartbeats[id]?.last()?.status)
      return out
    }),
  )
}

/** Mirror the filters into the query string without a navigation (shareable, survives reload). */
function writeFiltersToUrl(filters: MonitorFilters) {
  const query = serializeMonitorFilters(filters).toString()
  const url = `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`
  if (url !== `${window.location.pathname}${window.location.search}${window.location.hash}`) {
    window.history.replaceState(window.history.state, '', url)
  }
}

const NO_RESOURCES: MonitorListResources = { tags: [], notifications: null, locations: [] }
const NO_BULK: BulkPermissions = { update: false, delete: false }

/**
 * Live list of the organization's monitors with search, filters and multi-select bulk actions
 * (#124). The first render uses the server-loaded props so SSR and hydration agree; after mount the
 * store takes over and the socket keeps it fresh, so filtered views update live (a monitor that goes
 * down appears under `status:down` as soon as its beat arrives).
 */
export function MonitorList({
  orgSlug,
  initial,
  canCreate = true,
  initialFilters = EMPTY_FILTERS,
  resources = NO_RESOURCES,
  bulk = NO_BULK,
}: MonitorListProps) {
  const t = useTranslations('monitors.list')
  const tStatus = useTranslations('common.status')
  const tTypes = useTranslations('monitors.types')
  const locale = useLocale()
  const hydrated = useMonitorStore((s) => s.hydrated)
  const monitors = useMonitorStore((s) => s.monitors)
  const liveStatuses = useLiveStatuses()
  const searchRef = React.useRef<HTMLInputElement>(null)
  const listRef = React.useRef<HTMLUListElement>(null)
  const selectable = bulk.update || bulk.delete

  const [filters, setFilters] = React.useState<MonitorFilters>(initialFilters)
  // A navigation to the same page with another query string (a shared link) replaces the filters.
  const initialKey = serializeMonitorFilters(initialFilters).toString()
  const [appliedKey, setAppliedKey] = React.useState(initialKey)
  if (appliedKey !== initialKey) {
    setAppliedKey(initialKey)
    setFilters(initialFilters)
  }

  const updateFilters = React.useCallback((next: MonitorFilters) => {
    setFilters(next)
    writeFiltersToUrl(next)
  }, [])

  React.useEffect(() => {
    // Only seed the store when the socket has not already delivered a fresher list.
    if (!useMonitorStore.getState().hydrated) hydrateStore(initial)
  }, [initial])

  // Rows from the store once hydrated, from the server props before.
  const entries = React.useMemo(() => {
    if (hydrated) {
      return selectMonitorList({ monitors }, locale).map((monitor) => ({
        monitor,
        live: liveStatuses[monitor.id] ?? ('unknown' as const),
      }))
    }
    return initial.monitors.map((raw) => {
      const monitor = toStoreMonitor(raw)
      const beats = initial.heartbeats[raw.id] ?? []
      const last = beats[beats.length - 1]
      return { monitor, live: statusKey(last ? toStoreHeartbeat(last).status : undefined) }
    })
  }, [hydrated, monitors, liveStatuses, locale, initial])

  const locationNames = React.useMemo(
    () => Object.fromEntries(resources.locations.map((loc) => [loc.id, loc.name])),
    [resources.locations],
  )

  const shown = React.useMemo(() => {
    const parsed = parseSearchQuery(filters.q)
    return entries.filter(({ monitor, live }) =>
      matchesMonitorFilters(monitor, live, filters, { locationNames }, parsed),
    )
  }, [entries, filters, locationNames])

  const shownIds = React.useMemo(() => shown.map(({ monitor }) => monitor.id), [shown])
  const shownIdsRef = React.useRef(shownIds)
  React.useEffect(() => {
    shownIdsRef.current = shownIds
  }, [shownIds])

  // The selection never contains monitors that are not shown (filtered out or deleted), so a
  // bulk action only ever touches what the user sees.
  const retain = useMonitorSelection((s) => s.retain)
  React.useEffect(() => retain(shownIds), [retain, shownIds])
  const selectedMap = useMonitorSelection((s) => s.selected)
  const selectedIds = React.useMemo(
    () => shownIds.filter((id) => selectedMap[id]),
    [shownIds, selectedMap],
  )

  // Palette hand-off ("Search monitors") and lifecycle of the selection.
  const searchFocusPending = useMonitorSelection((s) => s.searchFocusPending)
  const cancelFocus = React.useRef<() => void>(() => undefined)
  React.useEffect(() => {
    if (!searchFocusPending || !useMonitorSelection.getState().takeSearchFocus()) return
    // Not an effect cleanup: taking the request re-renders, which must not cancel the focus.
    cancelFocus.current()
    cancelFocus.current = afterDialogsClose(() => searchRef.current?.focus())
  }, [searchFocusPending])
  React.useEffect(() => () => cancelFocus.current(), [])
  React.useEffect(() => {
    const store = useMonitorSelection.getState()
    store.setListMounted(true)
    return () => {
      store.setListMounted(false)
      store.clear()
    }
  }, [])

  const onSelect = React.useCallback<RowSelectHandler>((id, { range }) => {
    const store = useMonitorSelection.getState()
    if (range && store.anchor) store.selectRange(id, shownIdsRef.current)
    else store.toggle(id)
  }, [])

  const onNavigate = React.useCallback<RowNavigateHandler>((id, direction, { extend }) => {
    const ids = shownIdsRef.current
    const target = ids[ids.indexOf(id) + direction]
    if (!target) return
    if (extend) {
      const store = useMonitorSelection.getState()
      if (!store.anchor) store.toggle(id)
      store.selectRange(target, ids)
    }
    listRef.current
      ?.querySelector<HTMLInputElement>(`[${ROW_CHECKBOX_ATTR}="${CSS.escape(target)}"]`)
      ?.focus()
  }, [])

  const filterOptions = React.useMemo<FilterOptions>(() => {
    const types = [...new Set(entries.map(({ monitor }) => monitor.type))]
    const typeLabel = (type: string) =>
      tTypes.has(`${type}.label` as never) ? tTypes(`${type}.label` as never) : type
    const options: FilterOptions = {
      status: STATUS_FILTERS.map((value) => ({
        value,
        label: value === 'paused' ? t('paused') : tStatus(value),
      })),
      type: types
        .map((value) => ({ value, label: typeLabel(value) }))
        .sort((a, b) => a.label.localeCompare(b.label, locale)),
      tag: resources.tags.map((tag) => ({ value: tag.id, label: tag.name, color: tag.color })),
      notification: (resources.notifications ?? []).map((channel) => ({
        value: channel.id,
        label: channel.name,
      })),
      location:
        resources.locations.length > 0
          ? [
              { value: LOCAL_LOCATION, label: t('filters.localLocation') },
              ...resources.locations.map((loc) => ({ value: loc.id, label: loc.name })),
            ]
          : [],
    }
    return options
  }, [entries, resources, t, tStatus, tTypes, locale])

  if (entries.length === 0) {
    return (
      <EmptyState
        icon={Activity}
        title={t('emptyTitle')}
        description={canCreate ? t('emptyDescription') : t('emptyDescriptionViewer')}
        action={
          canCreate ? (
            <Button asChild>
              <Link href={`/${orgSlug}/monitors/new`}>
                <Plus /> {t('addFirst')}
              </Link>
            </Button>
          ) : undefined
        }
      />
    )
  }

  const rows = shown.map(({ monitor }) =>
    hydrated ? (
      <MonitorRow
        key={monitor.id}
        id={monitor.id}
        orgSlug={orgSlug}
        onSelect={selectable ? onSelect : undefined}
        onNavigate={selectable ? onNavigate : undefined}
      />
    ) : (
      <InitialRow
        key={monitor.id}
        monitor={monitor}
        initial={initial}
        orgSlug={orgSlug}
        selection={
          selectable
            ? { selected: Boolean(selectedMap[monitor.id]), onSelect, onNavigate }
            : undefined
        }
      />
    ),
  )

  const tagOptions: FilterOption[] = filterOptions.tag ?? []
  const channelOptions: FilterOption[] | null = resources.notifications
    ? (filterOptions.notification ?? [])
    : null

  return (
    <div className="grid gap-4">
      <MonitorListToolbar
        filters={filters}
        onChange={updateFilters}
        options={filterOptions}
        searchRef={searchRef}
      />
      <p className="sr-only" role="status" aria-live="polite" data-testid="monitor-list-count">
        {t('summary', { shown: shown.length, total: entries.length })}
      </p>
      <div className="overflow-hidden rounded-xl border bg-card">
        {selectable && (
          <MonitorBulkBar
            orgId={String(initial.organizationId)}
            selectedIds={selectedIds}
            shownIds={shownIds}
            permissions={bulk}
            tags={tagOptions}
            notifications={channelOptions}
          />
        )}
        <div className="hidden items-center border-b md:flex" aria-hidden>
          {selectable && <span className="w-8 shrink-0" />}
          <div className="grid flex-1 grid-cols-[auto_minmax(0,1fr)_minmax(8rem,14rem)_5rem_5rem] items-center gap-x-3 px-4 py-2 text-xs font-medium text-muted-foreground">
            <span className="w-2.5" />
            <span>{t('columns.monitor')}</span>
            <span>{t('columns.lastChecks', { count: UPTIME_BAR_BEATS })}</span>
            <span className="text-right">{t('columns.uptime24h')}</span>
            <span className="text-right">{t('columns.ping')}</span>
          </div>
        </div>
        {rows.length > 0 ? (
          <ul ref={listRef} className="divide-y" aria-label={t('listLabel')}>
            {rows}
          </ul>
        ) : (
          <div className="p-6">
            <EmptyState
              icon={SearchX}
              title={t('noMatchesTitle')}
              description={t('noMatchesDescription')}
              action={
                <Button variant="outline" onClick={() => updateFilters({ ...EMPTY_FILTERS })}>
                  {t('filters.clear')}
                </Button>
              }
            />
          </div>
        )}
      </div>
    </div>
  )
}

/** A row rendered from the server props until the store is hydrated. */
function InitialRow({
  monitor,
  initial,
  orgSlug,
  selection,
}: {
  monitor: MonitorSummary
  initial: MonitorListInitialState
  orgSlug: string
  selection?: React.ComponentProps<typeof MonitorRowView>['selection']
}) {
  return (
    <MonitorRowView
      monitor={monitor}
      beats={(initial.heartbeats[monitor.id] ?? []).map(toStoreHeartbeat)}
      uptime24h={initial.uptime[monitor.id]?.['24h']}
      href={`/${orgSlug}/monitors/${monitor.id}`}
      selection={selection}
    />
  )
}

/** Small "Live" / "Reconnecting" pill driven by the socket state. */
export function RealtimeIndicator({ className }: { className?: string }) {
  const t = useTranslations('monitors.realtime')
  const { state } = useRealtimeConnection()
  const live = state === 'connected'
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium',
        live ? 'text-foreground' : 'text-muted-foreground',
        className,
      )}
      role="status"
      aria-live="polite"
    >
      {live ? (
        <Radio className="size-3 text-status-up" aria-hidden />
      ) : (
        <WifiOff className="size-3" aria-hidden />
      )}
      {live ? t('live') : state === 'connecting' ? t('connecting') : t('reconnecting')}
    </span>
  )
}
