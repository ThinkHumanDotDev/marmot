import type { Payload, Where } from 'payload'

import { LOCAL_LOCATION, monitorLocationKeys, type LocationStatus } from '@/lib/probe-locations'
import type { Location, Monitor } from '@/payload-types'
import { loadLocationStates } from '@/server/engine/quorum-store'
import { getLocationStats } from '@/server/stats/location-stats'

/** One row of the per-location status table of a multi-location monitor (#92). */
export interface MonitorLocationRow {
  /** Location id, or `local`. */
  key: string
  /** Location name; `null` for the local workers (the UI labels them). */
  name: string | null
  /** Probe connection status; `null` for the local workers. */
  probeStatus: LocationStatus | null
  status: NonNullable<Monitor['status']>['lastStatus'] | null
  lastCheckAt: string | null
  lastPing: number | null
  lastMsg: string | null
  uptime24h: number | null
  uptime30d: number | null
  avgPing24h: number | null
}

/** Hourly average response time of one location over the last 24 hours. */
export interface LocationLatencySeries {
  key: string
  name: string | null
  points: { timestamp: number; ping: number | null }[]
}

export interface MonitorLocationView {
  rows: MonitorLocationRow[]
  series: LocationLatencySeries[]
}

/**
 * Per-location state and figures of a multi-location monitor for its detail page. The caller has
 * verified access to the monitor; `monitor.locations` is populated (depth 1) when the user may
 * read the locations, ids otherwise (the rows then show the id).
 */
export async function loadMonitorLocationView(
  payload: Payload,
  monitor: Monitor,
  now: Date = new Date(),
): Promise<MonitorLocationView> {
  const keys = monitorLocationKeys(monitor)
  const docs = new Map(
    (monitor.locations ?? [])
      .filter((value): value is Location => typeof value === 'object' && value !== null)
      .map((doc) => [String(doc.id), doc]),
  )
  const [states, day, month] = await Promise.all([
    loadLocationStates(payload, monitor.id),
    getLocationStats(payload, monitor.id, '24h', { now }),
    getLocationStats(payload, monitor.id, '30d', { now }),
  ])
  const rows = keys.map((key): MonitorLocationRow => {
    const doc = docs.get(key)
    const state = states.get(key)
    const local = key === LOCAL_LOCATION
    return {
      key,
      name: local ? null : (doc?.name ?? key),
      probeStatus: local ? null : ((doc?.status ?? 'unknown') as LocationStatus),
      status: state?.lastStatus ?? null,
      lastCheckAt: state?.lastCheckAt ?? null,
      lastPing: state?.lastPing ?? null,
      lastMsg: state?.lastMsg ?? null,
      uptime24h: day.get(key) ? day.get(key)!.uptime : null,
      uptime30d: month.get(key) ? month.get(key)!.uptime : null,
      avgPing24h: day.get(key)?.avgPing ?? null,
    }
  })
  const series = rows.map((row) => ({
    key: row.key,
    name: row.name,
    points: (day.get(row.key)?.buckets ?? []).map((bucket) => ({
      timestamp: bucket.timestamp,
      ping: bucket.ping,
    })),
  }))
  return { rows, series }
}

/**
 * Heartbeat filter of the location filter (`?location=`): the location's id, or the beats without
 * one for the local workers (`null` on Postgres, `null` or missing on MongoDB).
 */
export function heartbeatLocationWhere(key: string): Where {
  if (key === LOCAL_LOCATION) {
    return { or: [{ location: { exists: false } }, { location: { equals: null } }] }
  }
  return { location: { equals: key } }
}
