/**
 * Wire → store mapping for realtime payloads (`src/server/realtime/events.ts`). Pure functions,
 * safe in client components and unit tests.
 */
import type {
  RealtimeHeartbeat,
  RealtimeHeartbeatStatus,
  RealtimeMonitor,
} from '@/server/realtime/events'
import { HeartbeatStatus, type Heartbeat, type MonitorSummary } from '@/stores/monitor-store'

const STATUS_BY_NAME: Record<RealtimeHeartbeatStatus, HeartbeatStatus> = {
  up: HeartbeatStatus.UP,
  down: HeartbeatStatus.DOWN,
  pending: HeartbeatStatus.PENDING,
  maintenance: HeartbeatStatus.MAINTENANCE,
  degraded: HeartbeatStatus.DEGRADED,
}

const NAME_BY_STATUS: Record<HeartbeatStatus, RealtimeHeartbeatStatus> = {
  [HeartbeatStatus.UP]: 'up',
  [HeartbeatStatus.DOWN]: 'down',
  [HeartbeatStatus.PENDING]: 'pending',
  [HeartbeatStatus.MAINTENANCE]: 'maintenance',
  [HeartbeatStatus.DEGRADED]: 'degraded',
}

/**
 * Server status strings (`heartbeats.status`) → store enum. Unknown values become PENDING: the
 * monitor is neither known up nor down, which is exactly what "pending" means on the dashboard.
 */
export function parseHeartbeatStatus(status: string | null | undefined): HeartbeatStatus {
  if (typeof status === 'string') {
    const match = STATUS_BY_NAME[status.toLowerCase() as RealtimeHeartbeatStatus]
    if (match !== undefined) return match
  }
  return HeartbeatStatus.PENDING
}

/** Store enum → server status string (used when the UI talks back to the API). */
export function heartbeatStatusName(status: HeartbeatStatus): RealtimeHeartbeatStatus {
  return NAME_BY_STATUS[status]
}

export function toStoreHeartbeat(beat: RealtimeHeartbeat): Heartbeat {
  return {
    monitor: String(beat.monitor),
    status: parseHeartbeatStatus(beat.status),
    time: beat.time,
    ping: beat.ping ?? null,
    msg: beat.msg ?? null,
    important: beat.important ?? false,
    duration: beat.duration ?? null,
  }
}

export function toStoreMonitor(monitor: RealtimeMonitor): MonitorSummary {
  return {
    id: String(monitor.id),
    name: monitor.name,
    type: monitor.type,
    active: monitor.active,
    interval: monitor.interval,
    url: monitor.url ?? null,
    hostname: monitor.hostname ?? null,
    organization: monitor.organization ?? null,
    tags: (monitor.tags ?? []).map((tag) => ({
      id: tag.id,
      name: tag.name,
      color: tag.color,
      value: tag.value,
    })),
    description: monitor.description ?? null,
    notifications: (monitor.notifications ?? []).map(String),
    locations: (monitor.locations ?? []).map(String),
    includeLocal: monitor.includeLocal === true,
  }
}
