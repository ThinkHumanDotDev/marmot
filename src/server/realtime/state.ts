/**
 * Initial realtime state of an organization: monitors, recent heartbeats and uptime figures.
 * Used by the realtime server when a socket joins an `org:<id>` room and by server components
 * that hydrate the monitor store before the socket connects.
 */
import type { Payload, PayloadRequest } from 'payload'

import { getStats, type StatsRange } from '@/server/stats/uptime-calculator'
import { isMonitorIncidentStatus } from '@/lib/monitor-incidents'
import type {
  RealtimeHeartbeat,
  RealtimeId,
  RealtimeLastIncident,
  RealtimeMonitor,
  RealtimeRange,
} from './events'
import {
  MONITOR_SUMMARY_SELECT,
  populateMonitorTags,
  toRealtimeHeartbeat,
  toRealtimeMonitor,
  type HeartbeatSource,
  type MonitorSummarySource,
} from './serialize'

export interface OrgRealtimeState {
  organizationId: RealtimeId
  monitors: RealtimeMonitor[]
  /** Per monitor, oldest → newest. */
  heartbeats: Record<RealtimeId, RealtimeHeartbeat[]>
  /** Per monitor, oldest → newest (only when `includeImportant`). */
  importantHeartbeats: Record<RealtimeId, RealtimeHeartbeat[]>
  uptime: Record<RealtimeId, Partial<Record<RealtimeRange, number>>>
  avgPing: Record<RealtimeId, Partial<Record<RealtimeRange, number | null>>>
  /** Newest monitor incident per monitor (monitors without one are absent). */
  lastIncidents: Record<RealtimeId, RealtimeLastIncident>
}

export interface LoadOrgStateOptions {
  /**
   * Request user for access control. With `overrideAccess: false` (default when a user is given)
   * the Local API applies the `monitors` access rules; the realtime server verifies membership
   * itself and passes `overrideAccess: true`. Heartbeats and stats of the monitors found are read
   * with `overrideAccess: true`.
   */
  user?: PayloadRequest['user']
  overrideAccess?: boolean
  /** Recent heartbeats per monitor (default 100). */
  heartbeatLimit?: number
  /** Recent important heartbeats per monitor (default 50; 0 skips the query). */
  importantLimit?: number
  /** Ranges to compute uptime/avgPing for (default 24h + 30d). */
  ranges?: RealtimeRange[]
  /** Parallel per-monitor queries (default 8). */
  concurrency?: number
}

/** Postgres/SQLite ids are numbers, MongoDB ids strings; coerce a wire id for a query. */
export function parseDocId(payload: Payload, id: string | number): string | number {
  if (typeof id === 'number') return id
  return payload.db.defaultIDType === 'number' && /^\d+$/.test(id) ? Number(id) : id
}

/** Run `fn` over `items` with at most `limit` in flight. */
async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await fn(items[index])
    }
  })
  await Promise.all(workers)
  return results
}

const isoDate = (value: unknown): string | null =>
  typeof value === 'string' ? value : value instanceof Date ? value.toISOString() : null

/**
 * Newest monitor incident of a monitor, read with the caller's access (`monitor-incident:read`):
 * a member without the permission simply gets none.
 */
async function lastIncident(
  payload: Payload,
  monitorId: string | number,
  access: { user?: PayloadRequest['user']; overrideAccess: boolean },
): Promise<RealtimeLastIncident | null> {
  try {
    const { docs } = await payload.find({
      collection: 'monitor-incidents',
      where: { monitor: { equals: monitorId } },
      select: { status: true, startedAt: true, resolvedAt: true },
      sort: '-startedAt',
      limit: 1,
      pagination: false,
      depth: 0,
      ...access,
    })
    const doc = docs[0] as
      | { id: string | number; status?: unknown; startedAt?: unknown; resolvedAt?: unknown }
      | undefined
    const startedAt = isoDate(doc?.startedAt)
    if (!doc || !startedAt || !isMonitorIncidentStatus(doc.status)) return null
    return {
      id: String(doc.id),
      status: doc.status,
      startedAt,
      resolvedAt: isoDate(doc.resolvedAt),
    }
  } catch {
    return null
  }
}

async function recentHeartbeats(
  payload: Payload,
  monitorId: string | number,
  limit: number,
  importantOnly = false,
): Promise<RealtimeHeartbeat[]> {
  if (limit <= 0) return []
  const conditions = [{ monitor: { equals: monitorId } }]
  if (importantOnly) conditions.push({ important: { equals: true } } as never)
  const { docs } = await payload.find({
    collection: 'heartbeats',
    where: { and: conditions },
    sort: '-time',
    limit,
    pagination: false,
    depth: 0,
    // The monitor was read with the caller's access in `loadOrgState`; its beats need no check of
    // their own (and stay readable even if the collection's rules tighten further).
    overrideAccess: true,
  })
  // Query newest-first so `limit` picks the latest beats, then hand out oldest → newest.
  return (docs as HeartbeatSource[]).map(toRealtimeHeartbeat).reverse()
}

export async function loadOrgState(
  payload: Payload,
  organizationId: string | number,
  options: LoadOrgStateOptions = {},
): Promise<OrgRealtimeState> {
  const access = {
    user: options.user,
    overrideAccess: options.overrideAccess ?? !options.user,
  }
  const heartbeatLimit = options.heartbeatLimit ?? 100
  const importantLimit = options.importantLimit ?? 50
  const ranges: RealtimeRange[] = options.ranges ?? ['24h', '30d']
  const orgId = parseDocId(payload, organizationId)

  const { docs } = await payload.find({
    collection: 'monitors',
    where: { organization: { equals: orgId } },
    select: MONITOR_SUMMARY_SELECT,
    sort: 'name',
    depth: 0,
    limit: 0,
    pagination: false,
    ...access,
  })
  const monitors = (await populateMonitorTags(payload, docs as MonitorSummarySource[])).map(
    toRealtimeMonitor,
  )

  const state: OrgRealtimeState = {
    organizationId: String(organizationId),
    monitors,
    heartbeats: {},
    importantHeartbeats: {},
    uptime: {},
    avgPing: {},
    lastIncidents: {},
  }

  await mapLimit(monitors, options.concurrency ?? 8, async (monitor) => {
    const monitorId = parseDocId(payload, monitor.id)
    const [beats, important, stats, incident] = await Promise.all([
      recentHeartbeats(payload, monitorId, heartbeatLimit),
      recentHeartbeats(payload, monitorId, importantLimit, true),
      Promise.all(ranges.map((range) => getStats(payload, monitorId, range as StatsRange))),
      lastIncident(payload, monitorId, access),
    ])
    if (incident) state.lastIncidents[monitor.id] = incident
    state.heartbeats[monitor.id] = beats
    if (importantLimit > 0) state.importantHeartbeats[monitor.id] = important
    state.uptime[monitor.id] = {}
    state.avgPing[monitor.id] = {}
    ranges.forEach((range, index) => {
      state.uptime[monitor.id][range] = stats[index].uptime
      state.avgPing[monitor.id][range] = stats[index].avgPing
    })
  })

  return state
}
