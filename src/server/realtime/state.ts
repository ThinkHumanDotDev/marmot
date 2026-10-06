/**
 * Initial realtime state of an organization: monitors, recent heartbeats and uptime figures.
 * Used by the realtime server when a socket joins an `org:<id>` room and by server components
 * that hydrate the monitor store before the socket connects.
 */
import type { Payload, PayloadRequest } from 'payload'

import { getStats, type StatsRange } from '@/server/stats/uptime-calculator'
import type { RealtimeHeartbeat, RealtimeId, RealtimeMonitor, RealtimeRange } from './events'
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
}

export interface LoadOrgStateOptions {
  /**
   * Request user for access control. With `overrideAccess: false` (default when a user is given)
   * the Local API applies the collection access functions; the realtime server verifies
   * membership itself and passes `overrideAccess: true`.
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

async function recentHeartbeats(
  payload: Payload,
  monitorId: string | number,
  limit: number,
  access: Pick<LoadOrgStateOptions, 'user' | 'overrideAccess'>,
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
    ...access,
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
  }

  await mapLimit(monitors, options.concurrency ?? 8, async (monitor) => {
    const monitorId = parseDocId(payload, monitor.id)
    const [beats, important, stats] = await Promise.all([
      recentHeartbeats(payload, monitorId, heartbeatLimit, access),
      recentHeartbeats(payload, monitorId, importantLimit, access, true),
      Promise.all(ranges.map((range) => getStats(payload, monitorId, range as StatsRange))),
    ])
    state.heartbeats[monitor.id] = beats
    if (importantLimit > 0) state.importantHeartbeats[monitor.id] = important
    state.uptime[monitor.id] = {}
    state.avgPing[monitor.id] = {}
    for (const result of stats) {
      state.uptime[monitor.id][result.range] = result.uptime
      state.avgPing[monitor.id][result.range] = result.avgPing
    }
  })

  return state
}
