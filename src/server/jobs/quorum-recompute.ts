/**
 * Quorum safety net (#92): every minute on the `marmot:maintenance` queue, recompute the status of
 * each active multi-location monitor from its per-location states and repair drift.
 *
 * Beats of different locations are recorded concurrently (workers, and the web process for probe
 * results), each reading the other locations' states before the other wrote. Two locations failing
 * at once can therefore both see the other still up and leave the monitor UP. The next beat
 * usually fixes that, but not when the locations stop reporting (a probe went offline). The job
 * compares the quorum with `monitors.status.lastStatus` and, when they differ, records a repair
 * beat (`trigger: 'quorum'`) through the same transition rules, so the missed notification and
 * incident still happen. It also deletes the state rows of locations a monitor no longer uses.
 */
import type { Payload } from 'payload'

import { childLogger } from '@/lib/logger'
import { isMultiLocation, monitorLocationKeys } from '@/lib/probe-locations'
import type { Heartbeat, Monitor } from '@/payload-types'
import type { PrevState } from '@/server/engine/beat'
import { emitHeartbeat } from '@/server/engine/hooks'
import {
  computeQuorumBeat,
  quorumMessage,
  quorumStatus,
  tallyLocations,
} from '@/server/engine/quorum'
import { loadLocationStates, locationNames } from '@/server/engine/quorum-store'

const log = childLogger('jobs:quorum')

export const QUORUM_RECOMPUTE_JOB_NAME = 'quorum-recompute'
export const QUORUM_RECOMPUTE_INTERVAL_MS = 60_000

/** Monitors checked within this window are left alone: one of their beats may be in flight. */
export const QUORUM_SETTLE_MS = 5_000

const relationId = (value: unknown): string | number | null => {
  if (value === null || value === undefined) return null
  if (typeof value === 'object') return (value as { id?: string | number }).id ?? null
  return value as string | number
}

export interface QuorumRepair {
  monitorId: string
  from: string | null
  to: string
}

export interface QuorumRecomputeResult {
  checked: number
  repaired: QuorumRepair[]
  /** State rows deleted because their location is no longer assigned. */
  pruned: number
}

/** Recompute one multi-location monitor; returns the repair it made, if any. */
export async function recomputeMonitorQuorum(
  payload: Payload,
  monitor: Monitor,
  now: Date = new Date(),
): Promise<QuorumRepair | null> {
  const keys = monitorLocationKeys(monitor)
  const states = await loadLocationStates(payload, monitor.id)
  const lastCheckAt = monitor.status?.lastCheckAt ? Date.parse(monitor.status.lastCheckAt) : 0
  if (now.getTime() - lastCheckAt < QUORUM_SETTLE_MS) return null
  const tally = tallyLocations(keys, states, monitor.quorum)
  if (tally.votes.unknown.length === tally.total) return null
  const status = quorumStatus(tally, null)
  const current = monitor.status?.lastStatus ?? null
  if (status === current) return null

  const prev: PrevState = {
    status: current,
    downCount: monitor.status?.downCount,
    settledStatus: monitor.status?.settledStatus,
  }
  const beat = computeQuorumBeat(prev, status, monitor, keys.length)
  const msg = quorumMessage(status, tally, await locationNames(payload, keys), states)
  const organizationId = relationId(monitor.organization)

  const heartbeat = (await payload.create({
    collection: 'heartbeats',
    depth: 0,
    overrideAccess: true,
    data: {
      monitor: monitor.id,
      organization: organizationId as Heartbeat['organization'],
      status,
      msg,
      ping: null,
      important: beat.important,
      retries: 0,
      downCount: beat.downCount,
      time: now.toISOString(),
      trigger: 'quorum',
    },
  })) as Heartbeat

  const updated = (await payload.update({
    collection: 'monitors',
    id: monitor.id,
    depth: 0,
    overrideAccess: true,
    context: { skipEngineSync: true },
    data: {
      status: {
        ...monitor.status,
        lastStatus: status,
        lastMsg: msg,
        downCount: beat.downCount,
        settledStatus: beat.settledStatus,
      },
    },
  })) as Monitor

  log.warn({ monitorId: monitor.id, from: current, to: status, msg }, 'quorum status repaired')
  await emitHeartbeat({
    payload,
    monitor: updated,
    heartbeat,
    previousStatus: current,
    isFirstBeat: beat.isFirstBeat,
    notify: beat.notify,
    notificationEvent: beat.notificationEvent,
    organizationId,
    repair: true,
  })
  return { monitorId: String(monitor.id), from: current, to: status }
}

/**
 * Delete the state rows of locations a monitor no longer uses (a location was unassigned, or the
 * monitor went back to a single location or was deleted).
 */
async function pruneLocationStates(
  payload: Payload,
  monitors: ReadonlyMap<string, Pick<Monitor, 'locations' | 'includeLocal'>>,
): Promise<number> {
  const { docs } = await payload.find({
    collection: 'monitor-location-states',
    select: { monitor: true, locationKey: true },
    depth: 0,
    limit: 0,
    pagination: false,
    overrideAccess: true,
  })
  let pruned = 0
  for (const row of docs) {
    const monitor = monitors.get(String(relationId(row.monitor)))
    if (
      monitor &&
      isMultiLocation(monitor) &&
      monitorLocationKeys(monitor).includes(row.locationKey)
    ) {
      continue
    }
    await payload.delete({
      collection: 'monitor-location-states',
      id: row.id,
      depth: 0,
      overrideAccess: true,
    })
    pruned += 1
  }
  return pruned
}

/** Prune stale state rows, then recompute every active multi-location monitor. */
export async function recomputeQuorumStatuses(
  payload: Payload,
  now: Date = new Date(),
): Promise<QuorumRecomputeResult> {
  const { docs } = await payload.find({
    collection: 'monitors',
    select: { locations: true, includeLocal: true, active: true },
    depth: 0,
    limit: 0,
    pagination: false,
    overrideAccess: true,
  })
  const result: QuorumRecomputeResult = { checked: 0, repaired: [], pruned: 0 }
  try {
    result.pruned = await pruneLocationStates(
      payload,
      new Map(docs.map((doc) => [String(doc.id), doc])),
    )
  } catch (err) {
    log.error({ err }, 'pruning location states failed')
  }
  for (const doc of docs) {
    if (doc.active === false || !isMultiLocation(doc)) continue
    result.checked += 1
    try {
      const monitor = (await payload.findByID({
        collection: 'monitors',
        id: doc.id,
        depth: 0,
        overrideAccess: true,
      })) as Monitor
      const repair = await recomputeMonitorQuorum(payload, monitor, now)
      if (repair) result.repaired.push(repair)
    } catch (err) {
      log.error({ err, monitorId: doc.id }, 'quorum recompute failed')
    }
  }
  return result
}
