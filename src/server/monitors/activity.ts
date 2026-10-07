/**
 * A monitor's recent check results, for the management API
 * (`GET /api/orgs/:orgId/monitors/:id/heartbeats`) and, through that route, the MCP endpoint (#119). Callers load the monitor with `loadOrgMonitor` first, which enforces the
 * organization and the user's access.
 */
import type { Payload, Where } from 'payload'

import type { Heartbeat, Monitor } from '@/payload-types'
import { HEARTBEAT_STATUSES } from '@/collections/Heartbeats'

export const MAX_HEARTBEATS = 500
export const DEFAULT_HEARTBEATS = 50

export type HeartbeatStatusFilter = (typeof HEARTBEAT_STATUSES)[number]

export const isHeartbeatStatus = (value: unknown): value is HeartbeatStatusFilter =>
  typeof value === 'string' && (HEARTBEAT_STATUSES as readonly string[]).includes(value)

export interface HeartbeatQuery {
  limit?: number
  status?: HeartbeatStatusFilter
  /** Only status changes (`important` beats), which are kept longer than raw beats. */
  importantOnly?: boolean
}

/** The monitor's most recent heartbeats, newest first. */
export async function listMonitorHeartbeats(
  payload: Payload,
  monitor: Pick<Monitor, 'id'>,
  query: HeartbeatQuery = {},
): Promise<Heartbeat[]> {
  const and: Where[] = [{ monitor: { equals: monitor.id } }]
  if (query.status) and.push({ status: { equals: query.status } })
  if (query.importantOnly) and.push({ important: { equals: true } })
  const limit = Math.min(Math.max(1, Math.trunc(query.limit ?? DEFAULT_HEARTBEATS)), MAX_HEARTBEATS)
  // Rows are written by the worker only; the monitor was already loaded with the caller's access.
  const { docs } = await payload.find({
    collection: 'heartbeats',
    where: { and },
    sort: '-time',
    limit,
    pagination: false,
    depth: 0,
    overrideAccess: true,
  })
  return docs as Heartbeat[]
}
