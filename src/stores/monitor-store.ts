import { create } from 'zustand'

import type { MonitorTagChip } from '@/lib/monitor-resources'
import { RingBuffer } from '@/lib/ring-buffer'

/**
 * Live monitor state fed by the realtime socket (see docs/Architecture.md → Realtime).
 * Pages hydrate it from the Local API on the server, then the socket client pushes updates.
 * Heartbeats never live in React state: components read them through the selectors below.
 */

/** Heartbeat status codes follow Uptime Kuma's vocabulary. */
export const HeartbeatStatus = {
  DOWN: 0,
  UP: 1,
  PENDING: 2,
  MAINTENANCE: 3,
  /** Marmot addition: the check succeeded but was slower than the monitor's `degradedAfter`. */
  DEGRADED: 4,
} as const
export type HeartbeatStatus = (typeof HeartbeatStatus)[keyof typeof HeartbeatStatus]

export type MonitorId = string

export interface Heartbeat {
  monitor: MonitorId
  status: HeartbeatStatus
  /** ISO timestamp. */
  time: string
  /** Response time in ms, when measured. */
  ping?: number | null
  msg?: string | null
  /** Status transition (UP↔DOWN etc.). */
  important?: boolean
  duration?: number | null
}

export interface MonitorSummary {
  id: MonitorId
  name: string
  type: string
  active: boolean
  interval: number
  url?: string | null
  hostname?: string | null
  tags?: MonitorTagChip[]
  organization?: string | number | null
}

export type UptimePeriod = '24h' | '30d' | '1y'
export type UptimeMap = Partial<Record<UptimePeriod, number>>

export const HEARTBEAT_BUFFER_SIZE = 100

export interface MonitorState {
  monitors: Record<MonitorId, MonitorSummary>
  heartbeats: Record<MonitorId, RingBuffer<Heartbeat>>
  importantHeartbeats: Record<MonitorId, RingBuffer<Heartbeat>>
  uptime: Record<MonitorId, UptimeMap>
  avgPing: Record<MonitorId, number>
  /** True once the initial monitor list arrived. */
  hydrated: boolean

  setMonitors: (monitors: MonitorSummary[]) => void
  upsertMonitor: (monitor: MonitorSummary) => void
  removeMonitor: (id: MonitorId) => void

  setHeartbeatList: (id: MonitorId, beats: Heartbeat[]) => void
  setImportantHeartbeatList: (id: MonitorId, beats: Heartbeat[]) => void
  pushHeartbeat: (beat: Heartbeat) => void

  setUptime: (id: MonitorId, period: UptimePeriod, value: number) => void
  setAvgPing: (id: MonitorId, value: number) => void

  reset: () => void
}

const initialState = {
  monitors: {},
  heartbeats: {},
  importantHeartbeats: {},
  uptime: {},
  avgPing: {},
  hydrated: false,
} satisfies Pick<
  MonitorState,
  'monitors' | 'heartbeats' | 'importantHeartbeats' | 'uptime' | 'avgPing' | 'hydrated'
>

const toId = (id: string | number): MonitorId => String(id)

export const useMonitorStore = create<MonitorState>()((set) => ({
  ...initialState,

  setMonitors: (list) =>
    set(() => {
      const monitors: Record<MonitorId, MonitorSummary> = {}
      for (const m of list) monitors[toId(m.id)] = { ...m, id: toId(m.id) }
      return { monitors, hydrated: true }
    }),

  upsertMonitor: (monitor) =>
    set((s) => ({
      monitors: { ...s.monitors, [toId(monitor.id)]: { ...monitor, id: toId(monitor.id) } },
    })),

  removeMonitor: (rawId) =>
    set((s) => {
      const id = toId(rawId)
      const omit = <T>(record: Record<MonitorId, T>) => {
        if (!(id in record)) return record
        const { [id]: _dropped, ...rest } = record
        return rest
      }
      return {
        monitors: omit(s.monitors),
        heartbeats: omit(s.heartbeats),
        importantHeartbeats: omit(s.importantHeartbeats),
        uptime: omit(s.uptime),
        avgPing: omit(s.avgPing),
      }
    }),

  setHeartbeatList: (rawId, beats) =>
    set((s) => ({
      heartbeats: {
        ...s.heartbeats,
        [toId(rawId)]: RingBuffer.from(beats, HEARTBEAT_BUFFER_SIZE),
      },
    })),

  setImportantHeartbeatList: (rawId, beats) =>
    set((s) => ({
      importantHeartbeats: {
        ...s.importantHeartbeats,
        [toId(rawId)]: RingBuffer.from(beats, HEARTBEAT_BUFFER_SIZE),
      },
    })),

  pushHeartbeat: (beat) =>
    set((s) => {
      const id = toId(beat.monitor)
      const current = s.heartbeats[id] ?? RingBuffer.create<Heartbeat>(HEARTBEAT_BUFFER_SIZE)
      const next: Partial<MonitorState> = {
        heartbeats: { ...s.heartbeats, [id]: current.push(beat) },
      }
      if (beat.important) {
        const important =
          s.importantHeartbeats[id] ?? RingBuffer.create<Heartbeat>(HEARTBEAT_BUFFER_SIZE)
        next.importantHeartbeats = { ...s.importantHeartbeats, [id]: important.push(beat) }
      }
      return next
    }),

  setUptime: (rawId, period, value) =>
    set((s) => {
      const id = toId(rawId)
      return { uptime: { ...s.uptime, [id]: { ...s.uptime[id], [period]: value } } }
    }),

  setAvgPing: (rawId, value) => set((s) => ({ avgPing: { ...s.avgPing, [toId(rawId)]: value } })),

  reset: () => set({ ...initialState }),
}))

// ---- Selectors (use with `useMonitorStore(selector)`) ---------------------------------------

const EMPTY_BEATS = RingBuffer.create<Heartbeat>(HEARTBEAT_BUFFER_SIZE)

export const selectMonitor = (id: string | number) => (s: MonitorState) => s.monitors[toId(id)]

/**
 * Monitors sorted by name. Pass the active locale (`useLocale()`) so the order follows the
 * language's collation rules; without one the runtime default is used.
 */
export const selectMonitorList = (
  s: Pick<MonitorState, 'monitors'>,
  locale?: string,
): MonitorSummary[] => {
  const collator = new Intl.Collator(locale)
  return Object.values(s.monitors).sort((a, b) => collator.compare(a.name, b.name))
}

export const selectHeartbeats = (id: string | number) => (s: MonitorState) =>
  s.heartbeats[toId(id)] ?? EMPTY_BEATS

export const selectImportantHeartbeats = (id: string | number) => (s: MonitorState) =>
  s.importantHeartbeats[toId(id)] ?? EMPTY_BEATS

export const selectLatestHeartbeat = (id: string | number) => (s: MonitorState) =>
  s.heartbeats[toId(id)]?.last()

export const selectUptime = (id: string | number, period: UptimePeriod) => (s: MonitorState) =>
  s.uptime[toId(id)]?.[period]

export const selectAvgPing = (id: string | number) => (s: MonitorState) => s.avgPing[toId(id)]

export type MonitorStatusKey = 'up' | 'down' | 'pending' | 'maintenance' | 'degraded' | 'unknown'

export const statusKey = (status: HeartbeatStatus | undefined): MonitorStatusKey => {
  switch (status) {
    case HeartbeatStatus.UP:
      return 'up'
    case HeartbeatStatus.DOWN:
      return 'down'
    case HeartbeatStatus.PENDING:
      return 'pending'
    case HeartbeatStatus.MAINTENANCE:
      return 'maintenance'
    case HeartbeatStatus.DEGRADED:
      return 'degraded'
    default:
      return 'unknown'
  }
}

/** Current status of each monitor from its newest heartbeat; paused monitors are `unknown`. */
export const selectMonitorStatus = (id: string | number) => (s: MonitorState) => {
  const monitor = s.monitors[toId(id)]
  if (!monitor || !monitor.active) return 'unknown' as const
  return statusKey(s.heartbeats[toId(id)]?.last()?.status)
}

/** Counts for the dashboard summary row. */
export const selectStatusCounts = (s: MonitorState): Record<MonitorStatusKey, number> => {
  const counts: Record<MonitorStatusKey, number> = {
    up: 0,
    down: 0,
    pending: 0,
    maintenance: 0,
    degraded: 0,
    unknown: 0,
  }
  for (const id of Object.keys(s.monitors)) counts[selectMonitorStatus(id)(s)] += 1
  return counts
}
