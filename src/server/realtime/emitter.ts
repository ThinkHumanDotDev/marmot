/**
 * Redis-backed socket.io emitter for the web and worker processes.
 *
 * Neither process holds a socket.io server; they publish to Redis with `@socket.io/redis-emitter`
 * and the realtime process (`src/realtime.ts`, Redis adapter) fans the events out to the
 * `org:<id>` rooms. The emitter is created lazily — no Redis connection is opened until the first
 * emit — and every emit is non-fatal: Redis trouble is logged, never thrown into a hook or the
 * check pipeline.
 */
import { Emitter } from '@socket.io/redis-emitter'
import type { Redis } from 'ioredis'

import { childLogger } from '@/lib/logger'
import { createRedis } from '@/server/redis'
import {
  orgRoom,
  RealtimeEvents,
  type RealtimeHeartbeat,
  type RealtimeId,
  type RealtimePayloads,
  type RealtimeRange,
  type ServerToClientEvents,
} from './events'
import { toRealtimeMonitor, type MonitorSummarySource } from './serialize'

const log = childLogger('realtime:emitter')

/** Default Redis key prefix of socket.io's adapter/emitter; tests use a unique one. */
export const DEFAULT_SOCKET_KEY = 'socket.io'

export interface EmitterOptions {
  /** Redis key prefix; must match the adapter key of the realtime server. */
  key?: string
  /** Redis connection to publish on (a dedicated lazy one is created by default). */
  redis?: Redis
}

type RealtimeEmitter = Emitter<ServerToClientEvents>

let current: { emitter: RealtimeEmitter; redis: Redis; owned: boolean } | null = null
let options: EmitterOptions = {}

/**
 * `@socket.io/redis-emitter` fires `publish` without awaiting it; wrap the client so a Redis
 * failure becomes a log line instead of an unhandled rejection.
 */
function publisher(redis: Redis) {
  let reported = false
  return {
    publish(channel: string, message: string | Buffer) {
      return redis.publish(channel, message).then(
        () => {
          reported = false
        },
        (err: unknown) => {
          if (!reported) {
            reported = true
            log.error({ err, channel }, 'failed to publish realtime event')
          }
        },
      )
    },
  }
}

function create(): NonNullable<typeof current> {
  const owned = !options.redis
  const redis =
    options.redis ??
    createRedis({
      lazyConnect: true,
      // Fail fast instead of queueing forever while Redis is unreachable; emits are fire-and-forget.
      maxRetriesPerRequest: 2,
      enableOfflineQueue: true,
    })
  const emitter = new Emitter<ServerToClientEvents>(publisher(redis), {
    key: options.key ?? DEFAULT_SOCKET_KEY,
  })
  return { emitter, redis, owned }
}

/** Process-wide emitter (lazy). */
export function getEmitter(): RealtimeEmitter {
  current ??= create()
  return current.emitter
}

/**
 * Replace the emitter configuration (tests: unique `key`, shared Redis). Closes the previous
 * emitter's connection when it owned it.
 */
export async function configureEmitter(next: EmitterOptions = {}): Promise<void> {
  await closeEmitter()
  options = next
}

/** Close the emitter's Redis connection (shutdown / tests). Safe when nothing was opened. */
export async function closeEmitter(): Promise<void> {
  const previous = current
  current = null
  if (previous?.owned) {
    try {
      await previous.redis.quit()
    } catch {
      previous.redis.disconnect()
    }
  }
}

function emitToOrg<E extends keyof RealtimePayloads>(
  organizationId: string | number,
  event: E,
  payload: RealtimePayloads[E],
): void {
  try {
    getEmitter()
      .to(orgRoom(organizationId))
      .emit(event, ...([payload] as Parameters<ServerToClientEvents[E]>))
  } catch (err) {
    log.error({ err, event, organizationId }, 'failed to emit realtime event')
  }
}

const id = (value: string | number): RealtimeId => String(value)

// ---- Helpers (web + worker) -------------------------------------------------------------------

export function emitHeartbeat(
  organizationId: string | number,
  input: { monitorId: string | number; heartbeat: RealtimeHeartbeat },
): void {
  emitToOrg(organizationId, RealtimeEvents.heartbeat, {
    organizationId: id(organizationId),
    monitorId: id(input.monitorId),
    heartbeat: input.heartbeat,
  })
}

export function emitHeartbeatList(
  organizationId: string | number,
  monitorId: string | number,
  heartbeats: RealtimeHeartbeat[],
): void {
  emitToOrg(organizationId, RealtimeEvents.heartbeatList, {
    organizationId: id(organizationId),
    monitorId: id(monitorId),
    heartbeats,
  })
}

/** A monitor was created or edited (`updateMonitorIntoList`). */
export function emitMonitorUpdated(
  organizationId: string | number,
  monitor: MonitorSummarySource,
): void {
  emitToOrg(organizationId, RealtimeEvents.updateMonitorIntoList, {
    organizationId: id(organizationId),
    monitor: toRealtimeMonitor(monitor),
  })
}

/** A monitor was deleted (`deleteMonitorFromList`). */
export function emitMonitorDeleted(
  organizationId: string | number,
  monitorId: string | number,
): void {
  emitToOrg(organizationId, RealtimeEvents.deleteMonitorFromList, {
    organizationId: id(organizationId),
    monitorId: id(monitorId),
  })
}

/** Full monitor list of an organization (rarely needed; the server sends it on connect). */
export function emitMonitorList(
  organizationId: string | number,
  monitors: MonitorSummarySource[],
): void {
  emitToOrg(organizationId, RealtimeEvents.monitorList, {
    organizationId: id(organizationId),
    monitors: monitors.map(toRealtimeMonitor),
  })
}

export function emitUptime(
  organizationId: string | number,
  monitorId: string | number,
  range: RealtimeRange,
  value: number,
): void {
  emitToOrg(organizationId, RealtimeEvents.uptime, {
    organizationId: id(organizationId),
    monitorId: id(monitorId),
    range,
    value,
  })
}

export function emitAvgPing(
  organizationId: string | number,
  monitorId: string | number,
  range: RealtimeRange,
  value: number | null,
): void {
  emitToOrg(organizationId, RealtimeEvents.avgPing, {
    organizationId: id(organizationId),
    monitorId: id(monitorId),
    range,
    value,
  })
}

export function emitMaintenanceList(organizationId: string | number, items: unknown[]): void {
  emitToOrg(organizationId, RealtimeEvents.maintenanceList, {
    organizationId: id(organizationId),
    items,
  })
}

export function emitNotificationList(organizationId: string | number, items: unknown[]): void {
  emitToOrg(organizationId, RealtimeEvents.notificationList, {
    organizationId: id(organizationId),
    items,
  })
}

export function emitCertInfo(
  organizationId: string | number,
  monitorId: string | number,
  info: unknown,
): void {
  emitToOrg(organizationId, RealtimeEvents.certInfo, {
    organizationId: id(organizationId),
    monitorId: id(monitorId),
    info,
  })
}
