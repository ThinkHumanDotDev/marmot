/**
 * Monitor type plugin interface. Heavily inspired by Uptime Kuma's `server/monitor-types/`.
 * Each type lives in its own file and registers itself in `./index.ts`.
 */
import type { Payload } from 'payload'

import type { RequestTiming } from '@/lib/request-timing'
import type { AssertionResult } from '@/lib/validation/assertions'
import type { Monitor } from '@/payload-types'
import type { TlsInfo } from '@/server/engine/tls'

import type { CapturedResponse } from './response-capture'

export type HeartbeatStatus = 'up' | 'down' | 'pending' | 'maintenance' | 'degraded'

export interface MonitorCheckContext {
  /** Monitor document as stored in the `monitors` collection (depth 0: relationships are ids). */
  monitor: Monitor
  /** Mutable heartbeat being produced by this check. */
  heartbeat: {
    status: HeartbeatStatus
    msg: string
    ping?: number | null
    [extra: string]: unknown
  }
  /** Abort signal honouring the monitor timeout. */
  signal: AbortSignal
  /** Payload Local API for types that need other documents (groups, push). */
  payload: Payload
  /**
   * TLS certificate seen during the check, set by types that talk TLS (`performHttpCheck`).
   * The worker stores it in `monitors.certInfo` and feeds the expiry notifications.
   */
  tlsInfo?: TlsInfo | null
  /**
   * Per-assertion outcome of this check (HTTP and DNS types, see `./assertions.ts`), whatever the
   * verdict. The worker stores it on the heartbeat (`heartbeats.assertions`).
   */
  assertions?: AssertionResult[] | null
  /**
   * Request timing phases of this check (HTTP types, TCP port), set when the type measures them.
   * The worker stores them on the heartbeat (`heartbeats.timing`) and rolls up their averages.
   */
  timing?: RequestTiming | null
  /**
   * Per-probe outcome of a multi-location check (Globalping), whatever the verdict. The worker
   * stores it on the heartbeat (`heartbeats.probes`).
   */
  probes?: ProbeResult[] | null
  /**
   * The response received by the check (HTTP types, #97): status code, capped headers and body,
   * secrets scrubbed (`./response-capture.ts`). The worker stores it on the heartbeat, the body
   * only for failed or degraded beats.
   */
  response?: CapturedResponse | null
}

/** One probe of a multi-location check (`heartbeats.probes`). */
export interface ProbeResult {
  /** Human-readable probe location, e.g. `Frankfurt, DE, EU, Hetzner Online GmbH (AS24940)`. */
  location: string
  /** Did this probe's measurement pass the type's criteria? */
  ok: boolean
  /** Latency in ms measured by the probe (average RTT, total HTTP/DNS time), when it has one. */
  latency: number | null
  /** Short outcome (`200 OK`, `0% loss`, the error). */
  msg: string
}

/**
 * Thrown by a check that could not judge the target for a reason on our side of the measurement,
 * e.g. the Globalping API rate limit. The engine records a PENDING beat with the message and keeps
 * the monitor's state as it was (like the "checker offline" beats, #148): no retry is used up, the
 * monitor never goes DOWN because of it and no notification is sent.
 */
export class CheckDeferredError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CheckDeferredError'
  }
}

export const isCheckDeferredError = (err: unknown): err is CheckDeferredError =>
  err instanceof Error && err.name === 'CheckDeferredError'

export interface MonitorType {
  /** Unique slug stored in `monitors.type`, e.g. `http`. */
  readonly name: string
  /** Human label for the UI. */
  readonly label: string
  /** UI grouping: general, passive, specific, database, game. */
  readonly group: 'general' | 'passive' | 'specific' | 'database' | 'game'
  /** Whether the type supports the condition builder. */
  readonly supportsConditions?: boolean
  /**
   * Allow `check()` to resolve with a status other than `up` (e.g. groups, manual monitors).
   * Without it, a resolved check that is not `up` is treated as an implementation error.
   */
  readonly allowCustomStatus?: boolean
  /**
   * Run the check. Resolve on success after setting `heartbeat.status = 'up'`,
   * throw an Error on failure (the engine converts it to DOWN/PENDING).
   */
  check(ctx: MonitorCheckContext): Promise<void>
}
