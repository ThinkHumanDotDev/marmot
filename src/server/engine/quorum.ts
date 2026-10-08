/**
 * Multi-location quorum (#92), the pure part.
 *
 * A monitor checked from several locations runs the ordinary state machine (`computeNextBeat`:
 * retries, upside-down, degraded, recovery threshold, checker-offline holds) once per location, on
 * that location's own state. The layer here sits above it: it counts the locations' states
 * (`tallyLocations`), derives the monitor's status from them (`quorumStatus`), and judges the
 * monitor-level transition (`computeQuorumBeat`). Only monitor-level transitions are important and
 * notify; per-location changes are recorded on the heartbeats (`locationStatus`) and in the
 * per-location state rows, silently.
 *
 * A monitor checked from a single location never gets here (`recordBeat` keeps the plain path), and
 * with one location every rule below reduces to that location's status anyway.
 */
import { quorumNeeded, type QuorumMode } from '@/lib/probe-locations'

import {
  DEGRADED,
  DOWN,
  isDegradedTransition,
  isImportantBeat,
  MAINTENANCE,
  notificationEventFor,
  PENDING,
  UP,
  type BeatStatus,
  type MonitorSettings,
  type NotificationEvent,
  type PrevState,
} from './beat'

/** What a location's state says about the target. */
export type LocationVote = 'up' | 'degraded' | 'down' | 'retrying' | 'maintenance' | 'unknown'

/** The state-machine state of one location (a `monitor-location-states` row). */
export interface LocationState {
  lastStatus?: BeatStatus | null
  recoveries?: number | null
  lastMsg?: string | null
}

/**
 * The vote of a location: DOWN counts as down, and so does a PENDING beat of a recovery streak
 * (the location is still DOWN until `successThreshold` successes); any other PENDING is a retry
 * that has not confirmed the failure yet. No state yet: unknown.
 */
export function voteOf(state: LocationState | null | undefined): LocationVote {
  switch (state?.lastStatus) {
    case UP:
      return 'up'
    case DEGRADED:
      return 'degraded'
    case DOWN:
      return 'down'
    case MAINTENANCE:
      return 'maintenance'
    case PENDING:
      return (state.recoveries ?? 0) > 0 ? 'down' : 'retrying'
    default:
      return 'unknown'
  }
}

export interface QuorumTally {
  /** Locations assigned to the monitor. */
  total: number
  /** Locations that must agree for the monitor to take a status (`quorumNeeded`). */
  needed: number
  /** Location keys by vote, in assignment order. */
  votes: Record<LocationVote, string[]>
}

/** Count the votes of the assigned locations (`keys`); states of other locations are ignored. */
export function tallyLocations(
  keys: readonly string[],
  states: ReadonlyMap<string, LocationState>,
  mode: QuorumMode | null | undefined,
): QuorumTally {
  const votes: Record<LocationVote, string[]> = {
    up: [],
    degraded: [],
    down: [],
    retrying: [],
    maintenance: [],
    unknown: [],
  }
  for (const key of keys) votes[voteOf(states.get(key))].push(key)
  return { total: keys.length, needed: quorumNeeded(mode, keys.length), votes }
}

/**
 * The monitor's status from the tally. `current` is the status the reporting location just took
 * (`null` for the recompute job, which has none):
 *
 * - MAINTENANCE when the reporting location is in maintenance (windows apply to the whole monitor,
 *   every location reports it) or, without one, when every known location is;
 * - DOWN when at least `needed` locations are down;
 * - PENDING when down and retrying locations together reach `needed` (the outage is not confirmed
 *   yet), or when no location has reported a success yet (the first beats of a failing monitor wait
 *   for the quorum instead of announcing UP);
 * - DEGRADED when degraded, down and retrying locations together reach `needed`;
 * - UP otherwise.
 *
 * Locations in maintenance or without a state count for nothing but the total, so `all` never
 * declares an outage before every location has confirmed it.
 */
export function quorumStatus(tally: QuorumTally, current: BeatStatus | null): BeatStatus {
  const { votes, needed } = tally
  const down = votes.down.length
  const retrying = votes.retrying.length
  const degraded = votes.degraded.length
  const healthy = votes.up.length + degraded
  if (current === MAINTENANCE) return MAINTENANCE
  if (current === null && votes.maintenance.length > 0 && healthy + down + retrying === 0) {
    return MAINTENANCE
  }
  if (down >= needed) return DOWN
  if (down + retrying >= needed) return PENDING
  if (healthy === 0) return PENDING
  if (degraded + down + retrying >= needed) return DEGRADED
  return UP
}

export interface QuorumBeat {
  status: BeatStatus
  important: boolean
  notify: boolean
  notificationEvent: NotificationEvent | null
  isFirstBeat: boolean
  downCount: number
  settledStatus: BeatStatus | null
  /** The status the transition was judged against. */
  previousStatus: BeatStatus | null | undefined
}

/**
 * Judge the monitor-level transition to `status` (from `quorumStatus`) with Uptime Kuma's rules
 * (`isImportantBeat`, `notificationEventFor`) on the monitor's own cached state. A PENDING monitor
 * whose last settled status was DOWN is judged as DOWN, so DOWN → PENDING → UP still announces the
 * recovery and DOWN → PENDING → DOWN does not announce the outage twice. Reminders count every
 * beat of every location, so `resendInterval` is scaled by the number of locations.
 */
export function computeQuorumBeat(
  prev: PrevState | null | undefined,
  status: BeatStatus,
  monitor: Pick<MonitorSettings, 'resendInterval'>,
  locations: number,
): QuorumBeat {
  const isFirstBeat = !prev?.status
  const prevSettled = (prev?.status === PENDING ? prev?.settledStatus : prev?.status) ?? null
  const previousStatus = prev?.status === PENDING && prevSettled === DOWN ? DOWN : prev?.status
  const settledStatus = status === PENDING ? prevSettled : status
  const important =
    isImportantBeat(isFirstBeat, previousStatus, status) ||
    isDegradedTransition(previousStatus, status, prevSettled)

  let downCount = prev?.downCount ?? 0
  let notificationEvent: NotificationEvent | null = null
  const resendEvery = Math.max(0, monitor.resendInterval ?? 0) * Math.max(1, locations)
  if (important) {
    notificationEvent = notificationEventFor(isFirstBeat, previousStatus, status, prevSettled)
    downCount = 0
  } else if (status === DOWN && resendEvery > 0) {
    downCount += 1
    if (downCount >= resendEvery) {
      notificationEvent = 'reminder'
      downCount = 0
    }
  }
  return {
    status,
    important,
    notify: notificationEvent !== null,
    notificationEvent,
    isFirstBeat,
    downCount,
    settledStatus,
    previousStatus,
  }
}

const LOCATION_MSG_MAX = 200

/** `Berlin (timeout)` for each key, with the location's last message when it has one. */
function describe(
  keys: readonly string[],
  names: ReadonlyMap<string, string>,
  states: ReadonlyMap<string, LocationState>,
): string {
  return keys
    .map((key) => {
      const name = names.get(key) ?? key
      const msg = states.get(key)?.lastMsg?.trim()
      return msg ? `${name} (${msg.slice(0, LOCATION_MSG_MAX)})` : name
    })
    .join(', ')
}

/**
 * Message of a monitor-level beat that is announced (transition or reminder): which locations
 * fail, so notifications name them. Heartbeat messages are stored in English like the state
 * machine's own (`Recovering 1/3`, the degraded message).
 */
export function quorumMessage(
  status: BeatStatus,
  tally: QuorumTally,
  names: ReadonlyMap<string, string>,
  states: ReadonlyMap<string, LocationState>,
): string {
  const { votes, total } = tally
  const failing = [...votes.down, ...votes.retrying]
  const of = (count: number) => `${count} of ${total} location${total === 1 ? '' : 's'}`
  switch (status) {
    case MAINTENANCE:
      return 'Monitor under maintenance'
    case DOWN:
      return `Down at ${of(votes.down.length)}: ${describe(votes.down, names, states)}`
    case PENDING:
      return failing.length > 0
        ? `Failing at ${of(failing.length)}, waiting for the quorum: ${describe(failing, names, states)}`
        : `Waiting for the quorum of ${of(tally.needed)}`
    case DEGRADED: {
      const unhealthy = [...votes.degraded, ...failing]
      return `Degraded at ${of(unhealthy.length)}: ${describe(unhealthy, names, states)}`
    }
    default: {
      const healthy = votes.up.length + votes.degraded.length
      const base = `Up at ${of(healthy)}`
      return failing.length > 0 ? `${base}; failing: ${describe(failing, names, states)}` : base
    }
  }
}
