/**
 * Stats module entry point.
 *
 * `registerStatsListener(payload)` hooks `recordHeartbeat` into the polling engine's heartbeat
 * fan-out (`src/server/engine/hooks.ts`). The engine hands listeners the stored heartbeat document,
 * so `time` arrives as an ISO string and is converted before it reaches the calculator.
 */
import type { Payload } from 'payload'

import { childLogger } from '@/lib/logger'

import { registerHeartbeatListener } from '@/server/engine/hooks'

import { recordHeartbeat, type HeartbeatStatus } from './uptime-calculator'

export * from './uptime-calculator'

const log = childLogger('stats')

/** Shape of the engine's heartbeat context (mirrors `src/server/engine/hooks.ts`). */
export type HeartbeatContext = {
  monitor: { id: string | number }
  heartbeat: {
    status: HeartbeatStatus
    ping?: number | null
    /** Request timing phases (#94), the stored heartbeat's `timing` group. */
    timing?: unknown
    /** The engine hands over the stored document, whose time is an ISO string. */
    time: Date | string
    important?: boolean | null
  }
  /** Held while the worker was offline (#148): not recorded, so it is neither up nor down. */
  checkerOffline?: boolean
  /** Deferred by the check (#142, rate limit): held like a checker offline beat. */
  deferred?: boolean
  /** Monitors are org-scoped, but the engine types the id as optional; beats without one are skipped. */
  organizationId?: string | number | null
}

type HeartbeatListener = (ctx: HeartbeatContext) => Promise<void> | void

/** Build the listener the engine calls for every heartbeat. */
export const createStatsListener =
  (payload: Payload): HeartbeatListener =>
  async (ctx) => {
    if (ctx.checkerOffline || ctx.deferred) return
    if (ctx.organizationId === null || ctx.organizationId === undefined) {
      log.warn(
        { monitorId: ctx.monitor.id },
        'heartbeat without an organization; stats not recorded',
      )
      return
    }
    try {
      await recordHeartbeat(payload, {
        monitorId: ctx.monitor.id,
        organizationId: ctx.organizationId,
        status: ctx.heartbeat.status,
        ping: ctx.heartbeat.ping ?? null,
        timing: ctx.heartbeat.timing,
        time: new Date(ctx.heartbeat.time),
      })
    } catch (error) {
      // Never let a stats failure break the heartbeat pipeline.
      log.error({ err: error, monitorId: ctx.monitor.id }, 'failed to record heartbeat stats')
    }
  }

let registered = false

export async function registerStatsListener(payload: Payload): Promise<boolean> {
  if (registered) return true
  registerHeartbeatListener(createStatsListener(payload))
  registered = true
  log.info('heartbeat stats listener registered')
  return true
}
