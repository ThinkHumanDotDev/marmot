'use client'

import * as React from 'react'

/**
 * View preferences of the monitor list (#276): list or table, the table's sort and its hidden
 * columns. They are remembered per user in this browser's localStorage, so they survive a reload
 * without a server round trip; the server render always shows the list.
 */

export const TABLE_COLUMNS = [
  'status',
  'name',
  'target',
  'type',
  'tags',
  'lastCheck',
  'uptime24h',
  'avgPing',
  'lastIncident',
] as const
export type TableColumn = (typeof TABLE_COLUMNS)[number]

/** Columns the table can sort by (tags hold several values and are not sortable). */
export const SORTABLE_COLUMNS: readonly TableColumn[] = TABLE_COLUMNS.filter((c) => c !== 'tags')
/** The name column links to the monitor and cannot be hidden. */
export const HIDEABLE_COLUMNS: readonly TableColumn[] = TABLE_COLUMNS.filter((c) => c !== 'name')

export type MonitorView = 'list' | 'table'
export type SortDirection = 'asc' | 'desc'

export interface MonitorTableSort {
  column: TableColumn
  direction: SortDirection
}

export interface MonitorViewPrefs {
  view: MonitorView
  sort: MonitorTableSort
  hidden: TableColumn[]
}

export const DEFAULT_VIEW_PREFS: MonitorViewPrefs = {
  view: 'list',
  sort: { column: 'name', direction: 'asc' },
  hidden: [],
}

const storageKey = (userId: string) => `marmot:monitor-view:${userId}`
const CHANGE_EVENT = 'marmot:monitor-view-change'

const isColumn = (value: unknown): value is TableColumn =>
  typeof value === 'string' && (TABLE_COLUMNS as readonly string[]).includes(value)

/** Parses stored preferences, falling back to the defaults for anything unknown. */
export function parseViewPrefs(raw: string | null): MonitorViewPrefs {
  if (!raw) return DEFAULT_VIEW_PREFS
  try {
    const value = JSON.parse(raw) as Partial<Record<keyof MonitorViewPrefs, unknown>>
    const sort = (value.sort ?? {}) as Partial<Record<keyof MonitorTableSort, unknown>>
    return {
      view: value.view === 'table' ? 'table' : 'list',
      sort:
        isColumn(sort.column) && SORTABLE_COLUMNS.includes(sort.column)
          ? { column: sort.column, direction: sort.direction === 'desc' ? 'desc' : 'asc' }
          : DEFAULT_VIEW_PREFS.sort,
      hidden: Array.isArray(value.hidden)
        ? value.hidden.filter((c): c is TableColumn => isColumn(c) && HIDEABLE_COLUMNS.includes(c))
        : [],
    }
  } catch {
    return DEFAULT_VIEW_PREFS
  }
}

/** Fallback when localStorage is unavailable (private mode, blocked storage): until a reload. */
const memory = new Map<string, string>()

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key) ?? memory.get(key) ?? null
  } catch {
    return memory.get(key) ?? null
  }
}

function subscribe(onChange: () => void) {
  window.addEventListener('storage', onChange)
  window.addEventListener(CHANGE_EVENT, onChange)
  return () => {
    window.removeEventListener('storage', onChange)
    window.removeEventListener(CHANGE_EVENT, onChange)
  }
}

/** The signed-in user's monitor view preferences and a setter that persists them. */
export function useMonitorViewPrefs(
  userId: string,
): [MonitorViewPrefs, (update: (prefs: MonitorViewPrefs) => MonitorViewPrefs) => void] {
  const key = storageKey(userId)
  const raw = React.useSyncExternalStore(
    subscribe,
    () => read(key),
    () => null,
  )
  const prefs = React.useMemo(() => parseViewPrefs(raw), [raw])
  const update = React.useCallback(
    (fn: (prefs: MonitorViewPrefs) => MonitorViewPrefs) => {
      const value = JSON.stringify(fn(parseViewPrefs(read(key))))
      try {
        window.localStorage.setItem(key, value)
      } catch {
        memory.set(key, value)
      }
      window.dispatchEvent(new Event(CHANGE_EVENT))
    },
    [key],
  )
  return [prefs, update]
}
