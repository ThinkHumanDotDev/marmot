'use client'

import Link from 'next/link'
import { useFormatter, useTranslations } from 'next-intl'
import * as React from 'react'

import { StatusDot } from '@/components/status-dot'
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
import { useMonitorSelection } from '@/stores/monitor-selection-store'

import { TagList } from './tag-chip'
import { UptimeBar } from './uptime-bar'

/** Human label for the monitor target (URL for HTTP types, host:port otherwise). */
export function monitorTarget(monitor: Pick<MonitorSummary, 'type' | 'url' | 'hostname'>) {
  if (monitor.url) return monitor.url.replace(/^https?:\/\//, '')
  if (monitor.hostname) return monitor.hostname
  return null
}

/** How a row reports a click (or Space) on its checkbox; `range` when Shift was held. */
export type RowSelectHandler = (id: string, options: { range: boolean }) => void

/** Keyboard moves between row checkboxes (↑/↓, Shift extends the selection). */
export type RowNavigateHandler = (
  id: string,
  direction: 1 | -1,
  options: { extend: boolean },
) => void

export interface RowSelection {
  selected: boolean
  onSelect: RowSelectHandler
  onNavigate: RowNavigateHandler
}

interface MonitorRowViewProps {
  monitor: MonitorSummary
  beats: readonly Heartbeat[]
  uptime24h: number | undefined
  href: string
  /** Multi-select checkbox (members with bulk permissions only). */
  selection?: RowSelection
}

/** Data attribute of row checkboxes, used to move focus between them. */
export const ROW_CHECKBOX_ATTR = 'data-monitor-select'

function RowCheckbox({
  id,
  name,
  selection,
}: {
  id: string
  name: string
  selection: RowSelection
}) {
  const t = useTranslations('monitors.list.selection')
  return (
    <div className="flex items-center pl-4">
      <input
        type="checkbox"
        className="size-4 cursor-pointer accent-primary"
        checked={selection.selected}
        aria-label={t('selectMonitor', { name })}
        {...{ [ROW_CHECKBOX_ATTR]: id }}
        // Toggling happens in `onClick`, which knows whether Shift was held.
        onChange={() => undefined}
        onClick={(event) => selection.onSelect(id, { range: event.shiftKey })}
        onKeyDown={(event) => {
          if (event.key === ' ' && event.shiftKey) {
            // Shift+Space selects a range on key up; cancelling both halves suppresses the click.
            event.preventDefault()
          } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            selection.onNavigate(id, event.key === 'ArrowDown' ? 1 : -1, {
              extend: event.shiftKey,
            })
          }
        }}
        onKeyUp={(event) => {
          if (event.key === ' ' && event.shiftKey) {
            event.preventDefault()
            selection.onSelect(id, { range: true })
          }
        }}
      />
    </div>
  )
}

/** Presentational row; `MonitorRow` feeds it from the store, the server page from props. */
export function MonitorRowView({
  monitor,
  beats,
  uptime24h,
  href,
  selection,
}: MonitorRowViewProps) {
  const t = useTranslations('monitors')
  const tStatus = useTranslations('common.status')
  const format = useFormatter()
  const latest = beats[beats.length - 1]
  const status: MonitorStatusKey = monitor.active ? statusKey(latest?.status) : 'unknown'
  const target = monitorTarget(monitor)

  return (
    <li
      className={cn('flex items-stretch', selection?.selected && 'bg-accent/40')}
      data-selected={selection ? selection.selected : undefined}
    >
      {selection && <RowCheckbox id={monitor.id} name={monitor.name} selection={selection} />}
      <Link
        href={href}
        className={cn(
          'grid min-w-0 flex-1 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 px-4 py-3 transition-colors outline-none',
          'hover:bg-accent/50 focus-visible:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset md:grid-cols-[auto_minmax(0,1fr)_minmax(8rem,14rem)_5rem_5rem]',
        )}
        data-status={status}
      >
        <StatusDot status={status} />
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium">{monitor.name}</span>
            {!monitor.active && (
              <span className="rounded-full border px-1.5 text-[10px] font-medium text-muted-foreground uppercase">
                {t('list.paused')}
              </span>
            )}
          </div>
          <p className="truncate text-xs text-muted-foreground">
            <span className="uppercase">{monitor.type}</span>
            {target && <span className="before:mx-1.5 before:content-['·']">{target}</span>}
          </p>
          <TagList tags={monitor.tags} className="mt-1" />
        </div>
        <div className="col-span-3 md:col-span-1">
          <UptimeBar beats={beats} />
        </div>
        <div
          className="hidden text-right text-sm tabular-nums md:block"
          title={t('format.uptime24hTitle')}
        >
          {uptime24h === undefined || Number.isNaN(uptime24h)
            ? '—'
            : // Rounded to two decimals, "100%" once it rounds up (99.995% and above).
              uptime24h >= 0.99995
              ? format.number(1, 'wholePercent')
              : format.number(uptime24h, 'percent')}
        </div>
        <div
          className="hidden text-right text-sm text-muted-foreground tabular-nums md:block"
          title={latest ? t('format.latestResponseTime', { status: tStatus(status) }) : undefined}
        >
          {latest?.ping == null ? '—' : t('format.ping', { ms: Math.round(latest.ping) })}
        </div>
      </Link>
    </li>
  )
}

interface MonitorRowProps {
  id: string
  orgSlug: string
  /** Selection handlers; rows are selectable when set. */
  onSelect?: RowSelectHandler
  onNavigate?: RowNavigateHandler
}

/** Store-connected row: re-renders only when this monitor's data or selection changes. */
export const MonitorRow = React.memo(function MonitorRow({
  id,
  orgSlug,
  onSelect,
  onNavigate,
}: MonitorRowProps) {
  const monitor = useMonitorStore(selectMonitor(id))
  const beats = useMonitorStore(selectHeartbeats(id))
  const uptime24h = useMonitorStore(selectUptime(id, '24h'))
  const selected = useMonitorSelection((s) => Boolean(s.selected[id]))
  if (!monitor) return null
  return (
    <MonitorRowView
      monitor={monitor}
      beats={beats.toArray()}
      uptime24h={uptime24h}
      href={`/${orgSlug}/monitors/${id}`}
      selection={onSelect && onNavigate ? { selected, onSelect, onNavigate } : undefined}
    />
  )
})
