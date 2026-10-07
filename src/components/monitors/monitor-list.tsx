'use client'

import { Activity, Plus, Radio, WifiOff } from 'lucide-react'
import Link from 'next/link'
import { useLocale, useTranslations } from 'next-intl'
import * as React from 'react'

import { EmptyState } from '@/components/empty-state'
import { useRealtimeConnection } from '@/components/realtime/socket-provider'
import { Button } from '@/components/ui/button'
import { toStoreHeartbeat, toStoreMonitor } from '@/lib/realtime'
import { cn } from '@/lib/utils'
import type { OrgRealtimeState } from '@/server/realtime/state'
import { selectMonitorList, useMonitorStore } from '@/stores/monitor-store'

import { MonitorRow, MonitorRowView } from './monitor-row'
import { UPTIME_BAR_BEATS } from './uptime-bar'

/** Serialisable initial state produced by `loadOrgState` on the server. */
export type MonitorListInitialState = Pick<
  OrgRealtimeState,
  'organizationId' | 'monitors' | 'heartbeats' | 'uptime'
>

interface MonitorListProps {
  orgSlug: string
  initial: MonitorListInitialState
  /** `monitor:create`; viewers get the empty state without the call to action. */
  canCreate?: boolean
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

/**
 * Live list of the organization's monitors. The first render uses the server-loaded props so
 * SSR and hydration agree; after mount the store takes over and the socket keeps it fresh.
 */
export function MonitorList({ orgSlug, initial, canCreate = true }: MonitorListProps) {
  const t = useTranslations('monitors.list')
  const locale = useLocale()
  const hydrated = useMonitorStore((s) => s.hydrated)
  const monitors = useMonitorStore((s) => s.monitors)

  React.useEffect(() => {
    // Only seed the store when the socket has not already delivered a fresher list.
    if (!useMonitorStore.getState().hydrated) hydrateStore(initial)
  }, [initial])

  const ids = React.useMemo(
    () => selectMonitorList({ monitors }, locale).map((m) => m.id),
    [monitors, locale],
  )

  const rows = hydrated
    ? ids.map((id) => <MonitorRow key={id} id={id} orgSlug={orgSlug} />)
    : initial.monitors.map((monitor) => (
        <MonitorRowView
          key={monitor.id}
          monitor={toStoreMonitor(monitor)}
          beats={(initial.heartbeats[monitor.id] ?? []).map(toStoreHeartbeat)}
          uptime24h={initial.uptime[monitor.id]?.['24h']}
          href={`/${orgSlug}/monitors/${monitor.id}`}
        />
      ))

  if (rows.length === 0) {
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

  return (
    <div className="overflow-hidden rounded-xl border bg-card">
      <div
        aria-hidden
        className="hidden grid-cols-[auto_minmax(0,1fr)_minmax(8rem,14rem)_5rem_5rem] items-center gap-x-3 border-b px-4 py-2 text-xs font-medium text-muted-foreground md:grid"
      >
        <span className="w-2.5" aria-hidden />
        <span>{t('columns.monitor')}</span>
        <span>{t('columns.lastChecks', { count: UPTIME_BAR_BEATS })}</span>
        <span className="text-right">{t('columns.uptime24h')}</span>
        <span className="text-right">{t('columns.ping')}</span>
      </div>
      <ul className="divide-y" aria-label={t('listLabel')}>
        {rows}
      </ul>
    </div>
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
