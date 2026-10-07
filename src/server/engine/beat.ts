/**
 * Heartbeat state machine.
 *
 * Ported from Uptime Kuma 2.5.5 `server/model/monitor.js` (`Monitor.beat`, `isImportantBeat`,
 * `isImportantForNotification`) — Copyright (c) 2021 Louis Lam, MIT License. See THIRD_PARTY_NOTICES.md.
 *
 * Everything here is pure: the worker feeds the previous cached state plus the check result in and
 * persists what comes out. That keeps the transition rules unit-testable without Redis or a database.
 */
import type { HeartbeatStatus } from '@/server/monitor-types/types'
import type { TlsInfo } from './tls'

export type BeatStatus = HeartbeatStatus

export const UP: BeatStatus = 'up'
export const DOWN: BeatStatus = 'down'
export const PENDING: BeatStatus = 'pending'
export const MAINTENANCE: BeatStatus = 'maintenance'

/** State carried over from the previous heartbeat (the monitor's `status` cache group). */
export interface PrevState {
  /** Status of the previous beat; `undefined`/`null` means this is the first beat ever. */
  status?: BeatStatus | null
  retries?: number | null
  downCount?: number | null
}

/** Outcome of running `MonitorType.check()`. */
export interface CheckResult {
  /** `true` when `check()` resolved, `false` when it threw (or timed out). */
  ok: boolean
  /** Status set by the check when it resolved (`up` unless the type allows custom statuses). */
  status?: BeatStatus
  /** Message produced by the check or the error message. */
  msg: string
  /** Response time in ms, when measured. */
  ping?: number | null
  /** Duration in seconds reported by the check (push monitors). */
  duration?: number | null
  /** The monitor is inside an active maintenance window. */
  underMaintenance?: boolean
  /** TLS certificate captured by the check (HTTPS / TLS types), whatever the outcome. */
  tlsInfo?: TlsInfo | null
  /**
   * The outbound address guard refused the target: always DOWN, without retries or upside-down
   * flipping (the verdict does not depend on the target's state).
   */
  blocked?: boolean
  /**
   * The worker itself was offline (self connectivity check, `connectivity.ts`): the beat is held by
   * `holdBeatWhileCheckerOffline` instead of going through the transition rules.
   */
  checkerOffline?: boolean
}

/** Subset of the monitor document the state machine needs. */
export interface MonitorSettings {
  interval: number
  retryInterval?: number | null
  maxRetries?: number | null
  resendInterval?: number | null
  upsideDown?: boolean | null
}

export interface NextState {
  status: BeatStatus
  msg: string
  ping: number | null
  duration: number | null
  retries: number
  downCount: number
  /** Status changed compared to the previous beat (first beat included). */
  important: boolean
  /** Notification providers should be triggered for this beat. */
  notify: boolean
  /** Whether this is the first beat of the monitor. */
  isFirstBeat: boolean
  /** Seconds until the next check: `retryInterval` while pending, otherwise `interval`. */
  nextIntervalSeconds: number
}

/** Swap UP and DOWN; other statuses are returned unchanged. */
export function flipStatus(status: BeatStatus): BeatStatus {
  if (status === UP) return DOWN
  if (status === DOWN) return UP
  return status
}

/**
 * Has the status of the monitor changed since the last beat?
 * Verbatim port of `Monitor.isImportantBeat`.
 */
export function isImportantBeat(
  isFirstBeat: boolean,
  previousBeatStatus: BeatStatus | null | undefined,
  currentBeatStatus: BeatStatus,
): boolean {
  // * ? -> ANY STATUS = important [isFirstBeat]
  // UP -> PENDING = not important
  // * UP -> DOWN = important
  // UP -> UP = not important
  // PENDING -> PENDING = not important
  // * PENDING -> DOWN = important
  // PENDING -> UP = not important
  // DOWN -> PENDING = this case not exists
  // DOWN -> DOWN = not important
  // * DOWN -> UP = important
  // MAINTENANCE -> MAINTENANCE = not important
  // * MAINTENANCE -> UP = important
  // * MAINTENANCE -> DOWN = important
  // * DOWN -> MAINTENANCE = important
  // * UP -> MAINTENANCE = important
  return (
    isFirstBeat ||
    (previousBeatStatus === DOWN && currentBeatStatus === MAINTENANCE) ||
    (previousBeatStatus === UP && currentBeatStatus === MAINTENANCE) ||
    (previousBeatStatus === MAINTENANCE && currentBeatStatus === DOWN) ||
    (previousBeatStatus === MAINTENANCE && currentBeatStatus === UP) ||
    (previousBeatStatus === UP && currentBeatStatus === DOWN) ||
    (previousBeatStatus === DOWN && currentBeatStatus === UP) ||
    (previousBeatStatus === PENDING && currentBeatStatus === DOWN)
  )
}

/**
 * Is this beat important for notifications?
 * Verbatim port of `Monitor.isImportantForNotification`.
 */
export function isImportantForNotification(
  isFirstBeat: boolean,
  previousBeatStatus: BeatStatus | null | undefined,
  currentBeatStatus: BeatStatus,
): boolean {
  // * ? -> ANY STATUS = important [isFirstBeat]
  // UP -> PENDING = not important
  // * UP -> DOWN = important
  // UP -> UP = not important
  // PENDING -> PENDING = not important
  // * PENDING -> DOWN = important
  // PENDING -> UP = not important
  // DOWN -> PENDING = this case not exists
  // DOWN -> DOWN = not important
  // * DOWN -> UP = important
  // MAINTENANCE -> MAINTENANCE = not important
  // MAINTENANCE -> UP = not important
  // * MAINTENANCE -> DOWN = important
  // DOWN -> MAINTENANCE = not important
  // UP -> MAINTENANCE = not important
  return (
    isFirstBeat ||
    (previousBeatStatus === MAINTENANCE && currentBeatStatus === DOWN) ||
    (previousBeatStatus === UP && currentBeatStatus === DOWN) ||
    (previousBeatStatus === DOWN && currentBeatStatus === UP) ||
    (previousBeatStatus === PENDING && currentBeatStatus === DOWN)
  )
}

/** Seconds until the next check for a monitor in the given status. */
export function nextIntervalSeconds(status: BeatStatus, monitor: MonitorSettings): number {
  const interval = monitor.interval > 0 ? monitor.interval : 1
  if (status === PENDING && monitor.retryInterval && monitor.retryInterval > 0) {
    return monitor.retryInterval
  }
  return interval
}

/**
 * Compute the next heartbeat from the previous state and a check result.
 *
 * Mirrors the body of Uptime Kuma's `beat()` closure:
 * - the beat starts as DOWN (UP when upside down) and is flipped/overwritten by the check,
 * - failures become PENDING while `retries < maxRetries`, DOWN afterwards (retries keep counting),
 * - upside-down monitors treat a successful check as a failure ("Flip UP to DOWN"),
 * - `important` marks transitions; `notify` additionally honours `resendInterval` while DOWN and
 *   skips the very first beat unless it is DOWN (as `Monitor.sendNotification` does).
 */
export function computeNextBeat(
  prev: PrevState | null | undefined,
  result: CheckResult,
  monitor: MonitorSettings,
): NextState {
  if (result.checkerOffline) return holdBeatWhileCheckerOffline(prev, result, monitor)

  const isFirstBeat = !prev?.status
  const upsideDown = Boolean(monitor.upsideDown)
  const maxRetries = monitor.maxRetries ?? 0
  const resendInterval = monitor.resendInterval ?? 0

  let retries = prev?.retries ?? 0
  let downCount = prev?.downCount ?? 0
  let status: BeatStatus = upsideDown ? flipStatus(DOWN) : DOWN
  let msg = result.msg ?? ''
  const ping = result.ping ?? null
  const duration = result.duration ?? null

  try {
    if (result.underMaintenance) {
      status = MAINTENANCE
      msg = 'Monitor under maintenance'
    } else if (result.ok) {
      status = result.status ?? UP
      if (upsideDown) {
        status = flipStatus(status)
        if (status === DOWN) {
          throw new Error('Flip UP to DOWN')
        }
      }
      retries = 0
    } else {
      throw new Error(result.msg || 'Check failed')
    }
  } catch (error) {
    msg = error instanceof Error ? error.message : String(error)

    if (result.blocked) {
      status = DOWN
      retries++
    } else if (upsideDown && status === UP) {
      // If UP comes in here, it must be upside down mode: just reset the retries.
      retries = 0
    } else if (maxRetries > 0 && retries < maxRetries) {
      retries++
      status = PENDING
    } else {
      // Continue counting retries during DOWN.
      retries++
    }
  }

  const important = isImportantBeat(isFirstBeat, prev?.status, status)
  let notify = false

  if (important) {
    // The very first beat is only announced when it is DOWN (Monitor.sendNotification).
    notify =
      isImportantForNotification(isFirstBeat, prev?.status, status) &&
      (!isFirstBeat || status === DOWN)
    downCount = 0
  } else if (status === DOWN && resendInterval > 0) {
    ++downCount
    if (downCount >= resendInterval) {
      // Send the notification again because we are still DOWN.
      notify = true
      downCount = 0
    }
  }

  return {
    status,
    msg,
    ping,
    duration,
    retries,
    downCount,
    important,
    notify,
    isFirstBeat,
    nextIntervalSeconds: nextIntervalSeconds(status, monitor),
  }
}

/**
 * Marmot addition (#148): the beat of a check skipped (or failed) while the worker's own
 * connectivity was lost. It is PENDING ("checker offline") so nothing goes DOWN, never important or
 * notified, and it carries the previous retries/downCount over unchanged: the worker keeps the
 * monitor's cached status as it was, so the first real check after connectivity returns is judged
 * against the state from before the outage. The cadence stays the one of the previous status.
 */
export function holdBeatWhileCheckerOffline(
  prev: PrevState | null | undefined,
  result: CheckResult,
  monitor: MonitorSettings,
): NextState {
  return {
    status: PENDING,
    msg: result.msg,
    ping: null,
    duration: null,
    retries: prev?.retries ?? 0,
    downCount: prev?.downCount ?? 0,
    important: false,
    notify: false,
    isFirstBeat: !prev?.status,
    nextIntervalSeconds: nextIntervalSeconds(prev?.status ?? UP, monitor),
  }
}
