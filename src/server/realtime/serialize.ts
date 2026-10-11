/**
 * Convert Payload documents into the wire shapes of `events.ts`. Shared by the realtime server
 * (initial state), the emitter helpers (deltas) and server components that hydrate the store.
 */
import type { Payload } from 'payload'

import type { Heartbeat, Monitor, Tag } from '@/payload-types'
import type { RealtimeHeartbeat, RealtimeId, RealtimeMonitor, RealtimeTag } from './events'

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
  tags: true,
  description: true,
  notifications: true,
  locations: true,
  includeLocal: true,
} as const

export type MonitorSummarySource = Pick<Monitor, 'id' | 'name' | 'type' | 'interval'> &
  Partial<
    Pick<
      Monitor,
      | 'active'
      | 'url'
      | 'hostname'
      | 'parent'
      | 'organization'
      | 'tags'
      | 'description'
      | 'notifications'
      | 'locations'
      | 'includeLocal'
    >
  >

/** Ids of a has-many relationship, populated or not. */
function relationIds(value: readonly Relation[] | null | undefined): RealtimeId[] {
  if (!Array.isArray(value)) return []
  return value.map(relationId).filter((id): id is RealtimeId => id !== null)
}

/** Tags of a monitor whose `tags[].tag` is populated; unpopulated rows are skipped. */
export function toRealtimeTags(tags: Monitor['tags']): RealtimeTag[] {
  if (!Array.isArray(tags)) return []
  return tags.flatMap((row) =>
    row?.tag && typeof row.tag === 'object'
      ? [
          {
            id: String(row.tag.id),
            name: row.tag.name,
            color: row.tag.color ?? null,
            value: row.value ?? null,
          },
        ]
      : [],
  )
}

/**
 * Replace the tag ids of `docs[].tags[].tag` with the tag documents in one query, so list views
 * and realtime deltas can show chips without depth-1 queries of every relationship. Tags are
 * readable by every member who can read the monitor, so this reads with `overrideAccess`.
 */
export async function populateMonitorTags<T extends Pick<Monitor, 'tags'>>(
  payload: Payload,
  docs: T[],
): Promise<T[]> {
  const ids = new Set<string | number>()
  for (const doc of docs) {
    for (const row of doc.tags ?? []) {
      if (row && (typeof row.tag === 'string' || typeof row.tag === 'number')) ids.add(row.tag)
    }
  }
  if (ids.size === 0) return docs
  const { docs: tags } = await payload.find({
    collection: 'tags',
    where: { id: { in: [...ids] } },
    depth: 0,
    limit: ids.size,
    pagination: false,
    overrideAccess: true,
  })
  const byId = new Map((tags as Tag[]).map((tag) => [String(tag.id), tag]))
  return docs.map((doc) =>
    Array.isArray(doc.tags)
      ? {
          ...doc,
          tags: doc.tags.flatMap((row) => {
            if (row?.tag && typeof row.tag === 'object') return [row]
            const tag = byId.get(String(row?.tag))
            return tag ? [{ ...row, tag }] : []
          }),
        }
      : doc,
  )
}

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
    tags: toRealtimeTags(doc.tags),
    description: doc.description ?? null,
    notifications: relationIds(doc.notifications),
    locations: relationIds(doc.locations),
    includeLocal: doc.includeLocal === true,
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
