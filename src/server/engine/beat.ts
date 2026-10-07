/**
 * Heartbeat state machine.
 *
 * Ported from Uptime Kuma 2.5.5 `server/model/monitor.js` (`Monitor.beat`, `isImportantBeat`,
 * `isImportantForNotification`) — Copyright (c) 2021 Louis Lam, MIT License. See THIRD_PARTY_NOTICES.md.
 *
 * Marmot addition (#93): the DEGRADED status (a successful check slower than `degradedAfter`), its
 * transitions and the notification event of each beat (`notificationEventFor`).
 *
 * Everything here is pure: the worker feeds the previous cached state plus the check result in and
 * persists what comes out. That keeps the transition rules unit-testable without Redis or a database.
 */
import { degradedThresholdMs } from '@/lib/monitor-degraded'
import type { HeartbeatStatus } from '@/server/monitor-types/types'
import type { TlsInfo } from './tls'

export type BeatStatus = HeartbeatStatus

export const UP: BeatStatus = 'up'
export const DOWN: BeatStatus = 'down'
export const PENDING: BeatStatus = 'pending'
export const MAINTENANCE: BeatStatus = 'maintenance'
export const DEGRADED: BeatStatus = 'degraded'

/**
 * Why notification channels are told about a beat. Channels filter on it (#126); the default set
 * (`DEFAULT_NOTIFICATION_EVENTS` in `src/server/notifications/dispatch.ts`) keeps the behaviour from
 * before the degraded state, so `degraded` is opt-in.
 * - `down`: the monitor went DOWN (first beat included);
 * - `up`: it recovered from DOWN (to UP or DEGRADED);
 * - `degraded`: it entered DEGRADED or went back from DEGRADED to UP (not involving DOWN);
 * - `reminder`: `resendInterval` repeat while still DOWN.
 */
export const NOTIFICATION_EVENTS = ['down', 'up', 'degraded', 'reminder'] as const
export type NotificationEvent = (typeof NOTIFICATION_EVENTS)[number]

/** State carried over from the previous heartbeat (the monitor's `status` cache group). */
export interface PrevState {
  /** Status of the previous beat; `undefined`/`null` means this is the first beat ever. */
  status?: BeatStatus | null
  retries?: number | null
  downCount?: number | null
  /**
   * Last status that was not PENDING. Leaving a retry streak compares against it, so
   * DEGRADED → PENDING → UP still announces the end of the degradation. Missing on monitors
   * that have not been checked since the degraded state shipped.
   */
  settledStatus?: BeatStatus | null
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
}

/** Subset of the monitor document the state machine needs. */
export interface MonitorSettings {
  interval: number
  retryInterval?: number | null
  maxRetries?: number | null
  resendInterval?: number | null
  upsideDown?: boolean | null
  /** Monitor type; the degraded threshold only applies to the types in `DEGRADED_TYPES`. */
  type?: string | null
  /** Response time (ms) above which a successful check is DEGRADED; empty or 0 = off. */
  degradedAfter?: number | null
}

export interface NextState {
  status: BeatStatus
  msg: string
  ping: number | null
  duration: number | null
  retries: number
  downCount: number
  /** Last non-PENDING status (see `PrevState.settledStatus`). */
  settledStatus: BeatStatus | null
  /** Status changed compared to the previous beat (first beat included). */
  important: boolean
  /** Notification providers should be triggered for this beat. */
  notify: boolean
  /** Why notifications fire for this beat; `null` exactly when `notify` is false. */
  notificationEvent: NotificationEvent | null
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

/**
 * Does this beat enter or leave DEGRADED? Leaving PENDING compares with the status before the retry
 * streak (`settledStatus`), so UP → PENDING → DEGRADED and DEGRADED → PENDING → UP are transitions
 * while DEGRADED → PENDING → DEGRADED is not. Entering PENDING never is (as UP → PENDING).
 */
export function isDegradedTransition(
  previousBeatStatus: BeatStatus | null | undefined,
  currentBeatStatus: BeatStatus,
  settledStatus?: BeatStatus | null,
): boolean {
  const from = previousBeatStatus === PENDING ? settledStatus : previousBeatStatus
  if (!from || from === PENDING || currentBeatStatus === PENDING) return false
  if (from === currentBeatStatus) return false
  return from === DEGRADED || currentBeatStatus === DEGRADED
}

/**
 * Notification event of a beat, or `null` when channels stay quiet. Uptime Kuma's rules
 * (`isImportantForNotification`, first beat only when DOWN) decide `down` / `up`; DEGRADED adds:
 * DEGRADED → DOWN is `down`, DOWN → DEGRADED is `up` (a recovery, if a slow one), and the other
 * degraded transitions are `degraded`, except DEGRADED → MAINTENANCE (UP → MAINTENANCE is silent too).
 */
export function notificationEventFor(
  isFirstBeat: boolean,
  previousBeatStatus: BeatStatus | null | undefined,
  currentBeatStatus: BeatStatus,
  settledStatus?: BeatStatus | null,
): Exclude<NotificationEvent, 'reminder'> | null {
  if (isFirstBeat) return currentBeatStatus === DOWN ? 'down' : null
  if (isImportantForNotification(false, previousBeatStatus, currentBeatStatus)) {
    if (currentBeatStatus === DOWN) return 'down'
    if (currentBeatStatus === UP) return 'up'
  }
  if (!isDegradedTransition(previousBeatStatus, currentBeatStatus, settledStatus)) return null
  if (currentBeatStatus === DOWN) return 'down'
  if (previousBeatStatus === DOWN) return 'up'
  if (currentBeatStatus === MAINTENANCE) return null
  return 'degraded'
}

/** Message of a DEGRADED beat: the check's own message plus the threshold that was crossed. */
export function degradedMessage(msg: string, ping: number, thresholdMs: number): string {
  const detail = `response time ${Math.round(ping)} ms exceeds the degraded threshold of ${thresholdMs} ms`
  return msg.trim() ? `${msg.trim()} (${detail})` : detail.charAt(0).toUpperCase() + detail.slice(1)
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
      // A slow success is DEGRADED. Upside-down monitors never get here with a real response
      // (their UP comes from a failed check), so the threshold does not apply to them.
      const threshold = degradedThresholdMs(monitor)
      if (status === UP && !upsideDown && threshold !== null && ping !== null && ping > threshold) {
        status = DEGRADED
        msg = degradedMessage(msg, ping, threshold)
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

  // Status before the current retry streak (only stored state matters while PENDING).
  const prevSettled =
    (prev?.status === PENDING ? prev?.settledStatus : prev?.status) ?? null
  const settledStatus = status === PENDING ? prevSettled : status

  const important =
    isImportantBeat(isFirstBeat, prev?.status, status) ||
    isDegradedTransition(prev?.status, status, prevSettled)
  let notificationEvent: NotificationEvent | null = null

  if (important) {
    // The very first beat is only announced when it is DOWN (Monitor.sendNotification).
    notificationEvent = notificationEventFor(isFirstBeat, prev?.status, status, prevSettled)
    downCount = 0
  } else if (status === DOWN && resendInterval > 0) {
    ++downCount
    if (downCount >= resendInterval) {
      // Send the notification again because we are still DOWN.
      notificationEvent = 'reminder'
      downCount = 0
    }
  }
  const notify = notificationEvent !== null

  return {
    status,
    msg,
    ping,
    duration,
    retries,
    downCount,
    settledStatus,
    important,
    notify,
    notificationEvent,
    isFirstBeat,
    nextIntervalSeconds: nextIntervalSeconds(status, monitor),
  }
}
