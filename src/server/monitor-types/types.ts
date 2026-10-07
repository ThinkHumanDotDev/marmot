/**
 * Monitor type plugin interface. Heavily inspired by Uptime Kuma's `server/monitor-types/`.
 * Each type lives in its own file and registers itself in `./index.ts`.
 */
import type { Payload } from 'payload'

import type { RequestTiming } from '@/lib/request-timing'
import type { AssertionResult } from '@/lib/validation/assertions'
import type { Monitor } from '@/payload-types'
import type { TlsInfo } from '@/server/engine/tls'

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
}

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
