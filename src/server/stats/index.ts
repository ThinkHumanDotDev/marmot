/**
 * Stats module entry point.
 *
 * `registerStatsListener(payload)` hooks `recordHeartbeat` into the polling engine's heartbeat
 * fan-out (`src/server/engine/hooks.ts`, delivered by the engine issue). The import is dynamic so
 * this module works — and the worker still boots — while the engine is not merged yet.
 */
import type { Payload } from 'payload'

import { childLogger } from '@/lib/logger'

import { recordHeartbeat, type HeartbeatStatus } from './uptime-calculator'

export * from './uptime-calculator'

const log = childLogger('stats')

/** Shape of the engine's heartbeat context (mirrors `src/server/engine/hooks.ts`). */
export type HeartbeatContext = {
  monitor: { id: string | number }
  heartbeat: {
    status: HeartbeatStatus
    ping: number | null
    time: Date
    important: boolean
  }
  organizationId: string | number
}

type HeartbeatListener = (ctx: HeartbeatContext) => Promise<void> | void

type EngineHooksModule = {
  registerHeartbeatListener?: (fn: HeartbeatListener) => unknown
}

/** Build the listener the engine calls for every heartbeat. */
export const createStatsListener =
  (payload: Payload): HeartbeatListener =>
  async (ctx) => {
    try {
      await recordHeartbeat(payload, {
        monitorId: ctx.monitor.id,
        organizationId: ctx.organizationId,
        status: ctx.heartbeat.status,
        ping: ctx.heartbeat.ping,
        time: ctx.heartbeat.time,
      })
    } catch (error) {
      // Never let a stats failure break the heartbeat pipeline.
      log.error({ err: error, monitorId: ctx.monitor.id }, 'failed to record heartbeat stats')
    }
  }

let registered = false
let warnedMissingEngine = false

/**
 * Register the stats listener with the engine. Returns true when registered, false when the
 * engine hooks module is not available (logged once).
 */
export async function registerStatsListener(payload: Payload): Promise<boolean> {
  if (registered) return true

  // Resolved at runtime on purpose: the module ships with the engine issue.
  const hooksModulePath = '../engine/hooks'
  let hooks: EngineHooksModule
  try {
    hooks = (await import(/* webpackIgnore: true */ hooksModulePath)) as EngineHooksModule
  } catch (error) {
    if (!warnedMissingEngine) {
      warnedMissingEngine = true
      log.warn(
        { err: (error as Error).message },
        'engine hooks module not found; heartbeat stats are not recorded',
      )
    }
    return false
  }

  if (typeof hooks.registerHeartbeatListener !== 'function') {
    if (!warnedMissingEngine) {
      warnedMissingEngine = true
      log.warn('engine hooks module has no registerHeartbeatListener export')
    }
    return false
  }

  hooks.registerHeartbeatListener(createStatsListener(payload))
  registered = true
  log.info('heartbeat stats listener registered')
  return true
}
