'use client'

import { ArrowDown, ArrowUp, ArrowUpDown, Columns3, LayoutList, Table2 } from 'lucide-react'
import Link from 'next/link'
import { useFormatter, useTranslations } from 'next-intl'
import * as React from 'react'
import { useShallow } from 'zustand/react/shallow'

import { useNow } from '@/components/incidents/use-incidents'
import { StatusDot } from '@/components/status-dot'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { cn } from '@/lib/utils'
import { useMonitorSelection } from '@/stores/monitor-selection-store'
import {
  selectAvgPing,
  selectLastIncident,
  selectLatestHeartbeat,
  selectMonitor,
  selectUptime,
  statusKey,
  useMonitorStore,
  type MonitorState,
  type MonitorStatusKey,
} from '@/stores/monitor-store'

import {
  formatUptime,
  monitorTarget,
  RowCheckbox,
  type RowNavigateHandler,
  type RowSelectHandler,
} from './monitor-row'
import {
  HIDEABLE_COLUMNS,
  SORTABLE_COLUMNS,
  TABLE_COLUMNS,
  type MonitorTableSort,
  type MonitorView,
  type MonitorViewPrefs,
  type TableColumn,
} from './monitor-view-prefs'
import { TagList } from './tag-chip'

/** Status order of the status column (ascending: worst first, paused last). */
const STATUS_RANK: Record<MonitorStatusKey | 'paused', number> = {
  down: 0,
  pending: 1,
  degraded: 2,
  maintenance: 3,
  up: 4,
  unknown: 5,
  paused: 6,
}

type SortKey = string | number | null

/** Sort key of one monitor for `column`, read from the live store. */
function sortKey(s: MonitorState, id: string, column: TableColumn): SortKey {
  const monitor = s.monitors[id]
  if (!monitor) return null
  switch (column) {
    case 'status':
      return monitor.active ? STATUS_RANK[statusKey(s.heartbeats[id]?.last()?.status)] : 6
    case 'name':
      return monitor.name
    case 'target':
      return monitorTarget(monitor)
    case 'type':
      return monitor.type
    case 'lastCheck': {
      const time = s.heartbeats[id]?.last()?.time
      return time ? Date.parse(time) : null
    }
    case 'uptime24h': {
      const value = s.uptime[id]?.['24h']
      return value === undefined || Number.isNaN(value) ? null : value
    }
    case 'avgPing':
      return s.avgPing[id] ?? null
    case 'lastIncident': {
      const incident = s.lastIncident[id]
      return incident ? Date.parse(incident.startedAt) : null
    }
    default:
      return null
  }
}

/**
 * `ids` in the table's sort order. Only the sort column's keys are subscribed to, so a heartbeat
 * re-sorts the table only when it changes the value being sorted by. Empty values sort last in
 * both directions; ties keep the name order of `ids`.
 */
export function useSortedIds(
  ids: readonly string[],
  sort: MonitorTableSort,
  locale: string,
): string[] {
  const keys = useMonitorStore(useShallow((s) => ids.map((id) => sortKey(s, id, sort.column))))
  return React.useMemo(() => {
    const collator = new Intl.Collator(locale, { numeric: true })
    const factor = sort.direction === 'asc' ? 1 : -1
    return ids
      .map((id, index) => ({ id, index, key: keys[index] ?? null }))
      .sort((a, b) => {
        if (a.key === null || b.key === null) {
          return a.key === b.key ? a.index - b.index : a.key === null ? 1 : -1
        }
        const diff =
          typeof a.key === 'number' && typeof b.key === 'number'
            ? a.key - b.key
            : collator.compare(String(a.key), String(b.key))
        return diff === 0 ? a.index - b.index : diff * factor
      })
      .map(({ id }) => id)
  }, [ids, keys, sort.direction, locale])
}

/** List/table switch and, in the table, the column chooser. */
export function MonitorViewControls({
  prefs,
  onChange,
}: {
  prefs: MonitorViewPrefs
  onChange: (update: (prefs: MonitorViewPrefs) => MonitorViewPrefs) => void
}) {
  const t = useTranslations('monitors.list.view')
  const tColumns = useTranslations('monitors.list.table.columns')
  const setView = (view: MonitorView) => onChange((p) => ({ ...p, view }))
  return (
    <div className="flex items-center gap-2">
      {prefs.view === 'table' && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm">
              <Columns3 aria-hidden /> {t('columns')}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuLabel>{t('columnsLabel')}</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {HIDEABLE_COLUMNS.map((column) => (
              <DropdownMenuCheckboxItem
                key={column}
                checked={!prefs.hidden.includes(column)}
                onSelect={(event) => event.preventDefault()}
                onCheckedChange={(checked) =>
                  onChange((p) => ({
                    ...p,
                    hidden: checked
                      ? p.hidden.filter((c) => c !== column)
                      : [...p.hidden.filter((c) => c !== column), column],
                  }))
                }
              >
                {tColumns(column)}
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      <div role="group" aria-label={t('label')} className="inline-flex rounded-md border p-0.5">
        {(['list', 'table'] as const).map((view) => {
          const Icon = view === 'list' ? LayoutList : Table2
          const active = prefs.view === view
          return (
            <Button
              key={view}
              type="button"
              size="sm"
              variant={active ? 'secondary' : 'ghost'}
              className="h-7 px-2"
              aria-pressed={active}
              onClick={() => setView(view)}
            >
              <Icon aria-hidden /> {t(view)}
            </Button>
          )
        })}
      </div>
    </div>
  )
}

const NUMERIC_COLUMNS: readonly TableColumn[] = ['uptime24h', 'avgPing']

interface MonitorTableProps {
  /** Shown monitor ids in sort order. */
  ids: readonly string[]
  orgSlug: string
  sort: MonitorTableSort
  hidden: readonly TableColumn[]
  onSort: (column: TableColumn) => void
  onSelect?: RowSelectHandler
  onNavigate?: RowNavigateHandler
}

/**
 * Table view of the monitor list (#276): sortable columns, a column chooser and the same
 * selection and keyboard handling as the list. Rows read the live store, like `MonitorRow`.
 */
export function MonitorTable({
  ids,
  orgSlug,
  sort,
  hidden,
  onSort,
  onSelect,
  onNavigate,
}: MonitorTableProps) {
  const t = useTranslations('monitors.list.table')
  const columns = TABLE_COLUMNS.filter((column) => !hidden.includes(column))
  const selectable = Boolean(onSelect && onNavigate)
  // Relative "last check" times; 0 until mounted, so nothing renders against a stale clock.
  const now = useNow(0, true)

  return (
    <Table aria-label={t('label')} data-testid="monitor-table">
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          {selectable && (
            <TableHead className="w-8">
              <span className="sr-only">{t('columns.select')}</span>
            </TableHead>
          )}
          {columns.map((column) => {
            const label = t(`columns.${column}`)
            const sortable = SORTABLE_COLUMNS.includes(column)
            const active = sort.column === column
            const numeric = NUMERIC_COLUMNS.includes(column)
            const Icon = !active ? ArrowUpDown : sort.direction === 'asc' ? ArrowUp : ArrowDown
            return (
              <TableHead
                key={column}
                scope="col"
                aria-sort={
                  active ? (sort.direction === 'asc' ? 'ascending' : 'descending') : undefined
                }
                className={cn('px-3 text-xs text-muted-foreground', numeric && 'text-right')}
              >
                {sortable ? (
                  <button
                    type="button"
                    onClick={() => onSort(column)}
                    className={cn(
                      '-mx-1 inline-flex items-center gap-1 rounded px-1 py-0.5 font-medium hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
                      active && 'text-foreground',
                    )}
                  >
                    {label}
                    <Icon className={cn('size-3', !active && 'opacity-50')} aria-hidden />
                  </button>
                ) : (
                  label
                )}
              </TableHead>
            )
          })}
        </TableRow>
      </TableHeader>
      <TableBody>
        {ids.map((id) => (
          <MonitorTableRow
            key={id}
            id={id}
            orgSlug={orgSlug}
            columns={columns}
            now={now}
            onSelect={onSelect}
            onNavigate={onNavigate}
          />
        ))}
      </TableBody>
    </Table>
  )
}

interface MonitorTableRowProps {
  id: string
  orgSlug: string
  columns: readonly TableColumn[]
  now: number
  onSelect?: RowSelectHandler
  onNavigate?: RowNavigateHandler
}

/** Store-connected table row: re-renders only when this monitor's data or selection changes. */
const MonitorTableRow = React.memo(function MonitorTableRow({
  id,
  orgSlug,
  columns,
  now,
  onSelect,
  onNavigate,
}: MonitorTableRowProps) {
  const t = useTranslations('monitors')
  const tTypes = useTranslations('monitors.types')
  const tIncident = useTranslations('incidents.status')
  const format = useFormatter()
  const monitor = useMonitorStore(selectMonitor(id))
  const latest = useMonitorStore(selectLatestHeartbeat(id))
  const uptime24h = useMonitorStore(selectUptime(id, '24h'))
  const avgPing = useMonitorStore(selectAvgPing(id))
  const incident = useMonitorStore(selectLastIncident(id))
  const selected = useMonitorSelection((s) => Boolean(s.selected[id]))
  if (!monitor) return null

  const status: MonitorStatusKey = monitor.active ? statusKey(latest?.status) : 'unknown'
  const target = monitorTarget(monitor)
  const when = (iso: string) => {
    const date = new Date(iso)
    return (
      <time dateTime={iso} title={format.dateTime(date, 'precise')}>
        {now > 0 ? format.relativeTime(date, now) : format.dateTime(date, 'short')}
      </time>
    )
  }

  const cell = (column: TableColumn): React.ReactNode => {
    switch (column) {
      case 'status':
        return (
          <span className="flex items-center gap-2">
            <StatusDot status={status} />
            {!monitor.active && (
              <span className="rounded-full border px-1.5 text-[10px] font-medium text-muted-foreground uppercase">
                {t('list.paused')}
              </span>
            )}
          </span>
        )
      case 'name':
        return (
          <Link
            href={`/${orgSlug}/monitors/${id}`}
            className="block max-w-[16rem] truncate font-medium hover:underline focus-visible:rounded focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            {monitor.name}
          </Link>
        )
      case 'target':
        return (
          <span
            className="block max-w-[18rem] truncate text-muted-foreground"
            title={target ?? undefined}
          >
            {target ?? '—'}
          </span>
        )
      case 'type':
        return tTypes.has(`${monitor.type}.label` as never)
          ? tTypes(`${monitor.type}.label` as never)
          : monitor.type
      case 'tags':
        return monitor.tags?.length ? <TagList tags={monitor.tags} /> : '—'
      case 'lastCheck':
        return latest ? when(latest.time) : t('list.table.never')
      case 'uptime24h':
        return formatUptime(format, uptime24h)
      case 'avgPing':
        return avgPing == null ? '—' : t('format.ping', { ms: Math.round(avgPing) })
      case 'lastIncident':
        return incident ? (
          <span className="flex items-center gap-2">
            {when(incident.startedAt)}
            <span
              className={cn(
                'rounded-full border px-1.5 text-[10px] font-medium uppercase',
                incident.status === 'resolved'
                  ? 'text-muted-foreground'
                  : 'border-status-down/60 text-foreground',
              )}
            >
              {tIncident(incident.status)}
            </span>
          </span>
        ) : (
          '—'
        )
      default:
        return null
    }
  }

  return (
    <TableRow
      data-selected={onSelect ? selected : undefined}
      data-state={selected ? 'selected' : undefined}
      data-status={status}
    >
      {onSelect && onNavigate && (
        <TableCell className="w-8 py-2">
          <RowCheckbox
            id={id}
            name={monitor.name}
            selection={{ selected, onSelect, onNavigate }}
            className="pl-2"
          />
        </TableCell>
      )}
      {columns.map((column) => (
        <TableCell
          key={column}
          className={cn(
            'px-3 py-2.5',
            NUMERIC_COLUMNS.includes(column) && 'text-right tabular-nums',
            (column === 'lastCheck' || column === 'type') && 'text-muted-foreground',
          )}
        >
          {cell(column)}
        </TableCell>
      ))}
    </TableRow>
  )
})
