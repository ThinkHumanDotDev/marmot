/**
 * Multi-location quorum (#92), the stored part: per-location state rows
 * (`monitor-location-states`), location names for messages, and `applyQuorum`, which `recordBeat`
 * calls for a monitor checked from several locations.
 */
import type { Payload } from 'payload'

import { childLogger } from '@/lib/logger'
import { LOCAL_LOCATION, monitorLocationKeys } from '@/lib/probe-locations'
import type { Monitor, MonitorLocationState } from '@/payload-types'

import {
  computeNextBeat,
  holdBeatWhileCheckerOffline,
  type BeatStatus,
  type CheckResult,
  type NextState,
  type PrevState,
} from './beat'
import {
  computeQuorumBeat,
  quorumMessage,
  quorumStatus,
  tallyLocations,
  type LocationState,
  type QuorumTally,
} from './quorum'

const log = childLogger('engine:quorum')

type Id = string | number

const relationId = (value: unknown): Id | null => {
  if (value === null || value === undefined) return null
  if (typeof value === 'object') return (value as { id?: Id }).id ?? null
  return value as Id
}

/** Display name of the local worker pool in messages. */
export const LOCAL_LOCATION_NAME = 'local'

export type StoredLocationState = LocationState & {
  id: Id
  locationKey: string
} & Partial<
    Pick<
      MonitorLocationState,
      'settledStatus' | 'retries' | 'downCount' | 'lastCheckAt' | 'lastPing'
    >
  >

/** Every state row of a monitor, by location key. */
export async function loadLocationStates(
  payload: Payload,
  monitorId: Id,
): Promise<Map<string, StoredLocationState>> {
  const { docs } = await payload.find({
    collection: 'monitor-location-states',
    where: { monitor: { equals: monitorId } },
    depth: 0,
    limit: 0,
    pagination: false,
    overrideAccess: true,
  })
  return new Map(
    (docs as MonitorLocationState[]).map((doc) => [
      doc.locationKey,
      doc as unknown as StoredLocationState,
    ]),
  )
}

/** The state-machine input of a location from its row. */
export const prevStateOf = (row: StoredLocationState | null | undefined): PrevState => ({
  status: row?.lastStatus ?? null,
  retries: row?.retries ?? 0,
  downCount: row?.downCount ?? 0,
  settledStatus: (row?.settledStatus as BeatStatus | null | undefined) ?? null,
  recoveries: row?.recoveries ?? 0,
})

type StateData = Omit<StoredLocationState, 'id' | 'locationKey'>

/**
 * Upsert the row of `(monitor, key)`. A concurrent insert of the same pair trips the unique
 * index; the row is then re-read and updated.
 */
async function saveLocationState(
  payload: Payload,
  monitor: Monitor,
  key: string,
  existing: StoredLocationState | undefined,
  data: StateData,
): Promise<void> {
  const update = (id: Id) =>
    payload.update({
      collection: 'monitor-location-states',
      id,
      data: data as Partial<MonitorLocationState>,
      depth: 0,
      overrideAccess: true,
    })
  if (existing) {
    await update(existing.id)
    return
  }
  try {
    await payload.create({
      collection: 'monitor-location-states',
      data: {
        ...data,
        monitor: monitor.id,
        organization: relationId(monitor.organization),
        locationKey: key,
      } as unknown as MonitorLocationState,
      depth: 0,
      overrideAccess: true,
    })
  } catch (err) {
    const raced = (await loadLocationStates(payload, monitor.id)).get(key)
    if (!raced) throw err
    await update(raced.id)
  }
}

/** Names of the location keys (`local` for the worker pool; deleted locations keep their id). */
export async function locationNames(
  payload: Payload,
  keys: readonly string[],
): Promise<Map<string, string>> {
  const names = new Map<string, string>()
  const ids = keys.filter((key) => key !== LOCAL_LOCATION)
  if (keys.includes(LOCAL_LOCATION)) names.set(LOCAL_LOCATION, LOCAL_LOCATION_NAME)
  if (ids.length > 0) {
    const { docs } = await payload.find({
      collection: 'locations',
      where: { id: { in: ids } },
      select: { name: true },
      depth: 0,
      limit: ids.length,
      pagination: false,
      overrideAccess: true,
    })
    for (const doc of docs) names.set(String(doc.id), doc.name)
  }
  return names
}

export interface QuorumOutcome {
  /** The monitor-level beat to record (status = quorum, transitions judged on the monitor). */
  next: NextState
  /** The reporting location's own beat. */
  location: { key: string; prev: PrevState; next: NextState; lastCheckAt: string | null }
  tally: QuorumTally | null
}

/**
 * Run the reporting location's beat through the state machine on its own state, store it, and
 * derive the monitor-level beat from every assigned location's state. A beat held while the
 * checker was offline (#148, per location) holds the location's state and leaves the monitor's
 * untouched, exactly as on single-location monitors.
 */
export async function applyQuorum(
  payload: Payload,
  monitor: Monitor,
  key: string,
  result: CheckResult,
  now: Date,
): Promise<QuorumOutcome> {
  const keys = monitorLocationKeys(monitor)
  const states = await loadLocationStates(payload, monitor.id)
  const row = states.get(key)
  const prev = prevStateOf(row)
  const locationNext = computeNextBeat(prev, result, monitor)
  const held = result.checkerOffline === true || result.deferred === true

  const stored: StateData = {
    lastStatus: held ? (row?.lastStatus ?? null) : locationNext.status,
    settledStatus: locationNext.settledStatus,
    retries: locationNext.retries,
    downCount: locationNext.downCount,
    recoveries: locationNext.recoveries,
    lastCheckAt: now.toISOString(),
    lastPing: held ? (row?.lastPing ?? null) : locationNext.ping,
    lastMsg: locationNext.msg,
  }
  await saveLocationState(payload, monitor, key, row, stored)
  const location = { key, prev, next: locationNext, lastCheckAt: row?.lastCheckAt ?? null }

  const monitorPrev: PrevState = {
    status: monitor.status?.lastStatus,
    downCount: monitor.status?.downCount,
    settledStatus: monitor.status?.settledStatus,
  }
  if (held) {
    return {
      next: holdBeatWhileCheckerOffline(monitorPrev, result, monitor),
      location,
      tally: null,
    }
  }

  states.set(key, { ...row, ...stored, id: row?.id ?? '', locationKey: key })
  const tally = tallyLocations(keys, states, monitor.quorum)
  const status = quorumStatus(tally, locationNext.status)
  const beat = computeQuorumBeat(monitorPrev, status, monitor, keys.length)
  const msg =
    beat.important || beat.notify
      ? quorumMessage(status, tally, await locationNames(payload, keys), states)
      : locationNext.msg
  log.debug({ monitorId: monitor.id, key, status, votes: tally.votes }, 'quorum')

  return {
    next: {
      status,
      msg,
      ping: locationNext.ping,
      duration: locationNext.duration,
      // Retries and recovery streaks are per location; the monitor keeps none of its own.
      retries: 0,
      downCount: beat.downCount,
      settledStatus: beat.settledStatus,
      recoveries: 0,
      important: beat.important,
      notify: beat.notify,
      notificationEvent: beat.notificationEvent,
      isFirstBeat: beat.isFirstBeat,
      nextIntervalSeconds: locationNext.nextIntervalSeconds,
    },
    location,
    tally,
  }
}

/** `lastCheckAt` of one location of a monitor (probe ingest drops results not newer than it). */
export async function locationLastCheckAt(
  payload: Payload,
  monitorId: Id,
  key: string,
): Promise<string | null> {
  const { docs } = await payload.find({
    collection: 'monitor-location-states',
    where: { and: [{ monitor: { equals: monitorId } }, { locationKey: { equals: key } }] },
    select: { lastCheckAt: true },
    depth: 0,
    limit: 1,
    pagination: false,
    overrideAccess: true,
  })
  return (docs[0] as Pick<MonitorLocationState, 'lastCheckAt'> | undefined)?.lastCheckAt ?? null
}
