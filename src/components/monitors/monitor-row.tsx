'use client'

import Link from 'next/link'
import * as React from 'react'

import { StatusDot, statusLabel } from '@/components/status-dot'
import { cn } from '@/lib/utils'
import {
  selectHeartbeats,
  selectMonitor,
  selectUptime,
  statusKey,
  type Heartbeat,
  type MonitorStatusKey,
  type MonitorSummary,
} from '@/stores/monitor-store'
import { useMonitorStore } from '@/stores/monitor-store'

import { UptimeBar } from './uptime-bar'

/** Human label for the monitor target (URL for HTTP types, host:port otherwise). */
export function monitorTarget(monitor: Pick<MonitorSummary, 'type' | 'url' | 'hostname'>) {
  if (monitor.url) return monitor.url.replace(/^https?:\/\//, '')
  if (monitor.hostname) return monitor.hostname
  return null
}

export function formatUptime(value: number | undefined): string {
  if (value === undefined || Number.isNaN(value)) return '—'
  const percent = value * 100
  return `${percent >= 99.995 ? '100' : percent.toFixed(2)}%`
}

export function formatPing(ping: number | null | undefined): string {
  if (ping === null || ping === undefined) return '—'
  return `${Math.round(ping)} ms`
}

interface MonitorRowViewProps {
  monitor: MonitorSummary
  beats: readonly Heartbeat[]
  uptime24h: number | undefined
  href: string
}

/** Presentational row; `MonitorRow` feeds it from the store, the server page from props. */
export function MonitorRowView({ monitor, beats, uptime24h, href }: MonitorRowViewProps) {
  const latest = beats[beats.length - 1]
  const status: MonitorStatusKey = monitor.active ? statusKey(latest?.status) : 'unknown'
  const target = monitorTarget(monitor)

  return (
    <li>
      <Link
        href={href}
        className={cn(
          'grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 px-4 py-3 transition-colors outline-none',
          'hover:bg-accent/50 focus-visible:bg-accent/50 md:grid-cols-[auto_minmax(0,1fr)_minmax(8rem,14rem)_5rem_5rem]',
        )}
        data-status={status}
      >
        <StatusDot status={status} />
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium">{monitor.name}</span>
            {!monitor.active && (
              <span className="rounded-full border px-1.5 text-[10px] font-medium text-muted-foreground uppercase">
                Paused
              </span>
            )}
          </div>
          <p className="truncate text-xs text-muted-foreground">
            <span className="uppercase">{monitor.type}</span>
            {target && <span className="before:mx-1.5 before:content-['·']">{target}</span>}
          </p>
        </div>
        <div className="col-span-3 md:col-span-1">
          <UptimeBar beats={beats} />
        </div>
        <div className="hidden text-right text-sm tabular-nums md:block" title="Uptime, last 24 h">
          {formatUptime(uptime24h)}
        </div>
        <div
          className="hidden text-right text-sm text-muted-foreground tabular-nums md:block"
          title={latest ? `${statusLabel[status]} · latest response time` : undefined}
        >
          {formatPing(latest?.ping)}
        </div>
      </Link>
    </li>
  )
}

interface MonitorRowProps {
  id: string
  orgSlug: string
}

/** Store-connected row: re-renders only when this monitor's data changes. */
export function MonitorRow({ id, orgSlug }: MonitorRowProps) {
  const monitor = useMonitorStore(selectMonitor(id))
  const beats = useMonitorStore(selectHeartbeats(id))
  const uptime24h = useMonitorStore(selectUptime(id, '24h'))
  if (!monitor) return null
  return (
    <MonitorRowView
      monitor={monitor}
      beats={beats.toArray()}
      uptime24h={uptime24h}
      href={`/${orgSlug}/monitors/${id}`}
    />
  )
}
