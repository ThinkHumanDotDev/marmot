/**
 * Convert Payload documents into the wire shapes of `events.ts`. Shared by the realtime server
 * (initial state), the emitter helpers (deltas) and server components that hydrate the store.
 */
import type { Heartbeat, Monitor } from '@/payload-types'
import type { RealtimeHeartbeat, RealtimeId, RealtimeMonitor } from './events'

type Relation = string | number | { id: string | number } | null | undefined

/** Id of a relationship value whether or not it was populated. */
export function relationId(value: Relation): RealtimeId | null {
  if (value === null || value === undefined) return null
  return String(typeof value === 'object' ? value.id : value)
}

/** Monitor fields the list view needs (`select` these when querying). */
export const MONITOR_SUMMARY_SELECT = {
  name: true,
  type: true,
  active: true,
  interval: true,
  url: true,
  hostname: true,
  parent: true,
  organization: true,
} as const

export type MonitorSummarySource = Pick<Monitor, 'id' | 'name' | 'type' | 'interval'> &
  Partial<Pick<Monitor, 'active' | 'url' | 'hostname' | 'parent' | 'organization'>>

export function toRealtimeMonitor(doc: MonitorSummarySource): RealtimeMonitor {
  return {
    id: String(doc.id),
    name: doc.name,
    type: doc.type,
    active: doc.active !== false,
    interval: doc.interval,
    url: doc.url ?? null,
    hostname: doc.hostname ?? null,
    parent: relationId(doc.parent),
    organization: relationId(doc.organization),
  }
}

export type HeartbeatSource = Pick<Heartbeat, 'monitor' | 'status' | 'time'> &
  Partial<Pick<Heartbeat, 'ping' | 'msg' | 'important' | 'duration'>>

export function toRealtimeHeartbeat(doc: HeartbeatSource): RealtimeHeartbeat {
  return {
    monitor: relationId(doc.monitor) ?? '',
    status: doc.status,
    time: typeof doc.time === 'string' ? doc.time : new Date(doc.time).toISOString(),
    ping: doc.ping ?? null,
    msg: doc.msg ?? null,
    important: doc.important ?? false,
    duration: doc.duration ?? null,
  }
}
