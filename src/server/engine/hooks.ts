import type { Payload } from 'payload'

import { childLogger } from '@/lib/logger'
import type { Heartbeat, Monitor } from '@/payload-types'
import type { BeatStatus } from './beat'

const log = childLogger('engine:hooks')

/**
 * Emitted by the check worker after a heartbeat has been persisted and the monitor's status cache
 * has been refreshed. Stats rollups (#3), realtime (#6) and notifications subscribe to this.
 */
export interface HeartbeatEvent {
  payload: Payload
  /** Monitor document after the status cache update (depth 0: relationships are ids). */
  monitor: Monitor
  /** The heartbeat document that was just created. */
  heartbeat: Heartbeat
  /** Status of the previous heartbeat (`undefined` on the first beat). */
  previousStatus?: BeatStatus | null
  isFirstBeat: boolean
  /** The state machine decided notification providers should fire for this beat. */
  notify: boolean
  /** Organization id of the monitor, if any (handy for `org:<id>` rooms). */
  organizationId?: string | number | null
}

export type HeartbeatListener = (event: HeartbeatEvent) => void | Promise<void>

const listeners = new Set<HeartbeatListener>()

/**
 * Subscribe to heartbeats. Listeners run sequentially after each check; errors are logged and never
 * break the check pipeline. Returns an unsubscribe function.
 */
export function registerHeartbeatListener(fn: HeartbeatListener): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

/** Remove every listener (tests). */
export function clearHeartbeatListeners(): void {
  listeners.clear()
}

export async function emitHeartbeat(event: HeartbeatEvent): Promise<void> {
  for (const listener of listeners) {
    try {
      await listener(event)
    } catch (err) {
      log.error({ err, monitorId: event.monitor.id }, 'heartbeat listener failed')
    }
  }
}

/**
 * Resolves whether a monitor is currently inside an active maintenance window.
 * The maintenance issue installs the real implementation; until then nothing is under maintenance.
 */
export type MaintenanceResolver = (monitor: Monitor, payload: Payload) => Promise<boolean> | boolean

let maintenanceResolver: MaintenanceResolver = () => false

export function setMaintenanceResolver(fn: MaintenanceResolver | null): void {
  maintenanceResolver = fn ?? (() => false)
}

export async function isUnderMaintenance(monitor: Monitor, payload: Payload): Promise<boolean> {
  try {
    return await maintenanceResolver(monitor, payload)
  } catch (err) {
    log.error({ err, monitorId: monitor.id }, 'maintenance resolver failed')
    return false
  }
}
