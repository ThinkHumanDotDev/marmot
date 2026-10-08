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

import { recordLocationHeartbeat } from './location-stats'
import { recordHeartbeat, type HeartbeatStatus } from './uptime-calculator'

export * from './uptime-calculator'
export * from './location-stats'

const log = childLogger('stats')

/** Shape of the engine's heartbeat context (mirrors `src/server/engine/hooks.ts`). */
export type HeartbeatContext = {
  monitor: { id: string | number }
  heartbeat: {
    status: HeartbeatStatus
    ping?: number | null
    /** The engine hands over the stored document, whose time is an ISO string. */
    time: Date | string
    important?: boolean | null
  }
  /** Held while the worker was offline (#148): not recorded, so it is neither up nor down. */
  checkerOffline?: boolean
  /** A quorum repair beat (#92), not a check: not recorded. */
  repair?: boolean
  /** Multi-location monitors (#92): the reporting location and its own status. */
  location?: { key: string; status: HeartbeatStatus } | null
  /** Monitors are org-scoped, but the engine types the id as optional; beats without one are skipped. */
  organizationId?: string | number | null
}

type HeartbeatListener = (ctx: HeartbeatContext) => Promise<void> | void

/** Build the listener the engine calls for every heartbeat. */
export const createStatsListener =
  (payload: Payload): HeartbeatListener =>
  async (ctx) => {
    if (ctx.checkerOffline || ctx.repair) return
    if (ctx.organizationId === null || ctx.organizationId === undefined) {
      log.warn(
        { monitorId: ctx.monitor.id },
        'heartbeat without an organization; stats not recorded',
      )
      return
    }
    try {
      // A multi-location beat (#92) counts the quorum status; the response time of a location
      // whose own check failed does not feed the monitor's average.
      const locationFailed =
        ctx.location !== null &&
        ctx.location !== undefined &&
        ctx.location.status !== 'up' &&
        ctx.location.status !== 'degraded'
      await recordHeartbeat(payload, {
        monitorId: ctx.monitor.id,
        organizationId: ctx.organizationId,
        status: ctx.heartbeat.status,
        ping: locationFailed ? null : (ctx.heartbeat.ping ?? null),
        time: new Date(ctx.heartbeat.time),
      })
    } catch (error) {
      // Never let a stats failure break the heartbeat pipeline.
      log.error({ err: error, monitorId: ctx.monitor.id }, 'failed to record heartbeat stats')
    }
    if (ctx.location) {
      try {
        // The per-location series (#92), next to the monitor-wide rollups above.
        await recordLocationHeartbeat(payload, {
          monitorId: ctx.monitor.id,
          organizationId: ctx.organizationId,
          location: ctx.location.key,
          status: ctx.location.status,
          ping: ctx.heartbeat.ping ?? null,
          time: new Date(ctx.heartbeat.time),
        })
      } catch (error) {
        log.error({ err: error, monitorId: ctx.monitor.id }, 'failed to record location stats')
      }
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
