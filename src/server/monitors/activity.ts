/**
 * Read-outs of a monitor's recent activity and the "check now" action, shared by the management
 * API (`/api/orgs/:orgId/monitors/:id/{heartbeats,stats,check}`) and, through those routes, the MCP
 * endpoint (#119). Callers load the monitor with `loadOrgMonitor` first, which enforces the
 * organization and the user's access.
 */
import type { Payload, Where } from 'payload'

import type { Heartbeat, Monitor } from '@/payload-types'
import { CHECK_JOB_NAME } from '@/server/engine/names'
import { getChecksQueue, type ChecksQueue } from '@/server/engine/queues'
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

const QUEUE_TIMEOUT_MS = 5_000

/**
 * Queue an immediate one-off check of an active monitor on the checks queue. The worker runs it like
 * a scheduled check (state machine, notifications); the regular schedule is left alone.
 */
export async function queueMonitorCheck(
  monitor: Pick<Monitor, 'id'>,
  queue: ChecksQueue = getChecksQueue(),
): Promise<{ jobId: string | null; queuedAt: string }> {
  const queuedAt = new Date().toISOString()
  let timer: ReturnType<typeof setTimeout> | undefined
  const job = await Promise.race([
    queue.add(
      CHECK_JOB_NAME,
      { monitorId: String(monitor.id) },
      { removeOnComplete: 100, removeOnFail: 100 },
    ),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('check queue timed out')), QUEUE_TIMEOUT_MS)
    }),
  ]).finally(() => clearTimeout(timer))
  return { jobId: job.id ?? null, queuedAt }
}
