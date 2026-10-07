/**
 * Socket.IO event names and payload shapes shared by the realtime server, the Redis emitter
 * (web + worker) and the browser client. Names follow Uptime Kuma's vocabulary so the mental
 * model carries over; payloads are single JSON objects (not positional arguments) so they can
 * grow without breaking older clients.
 *
 * This module must stay free of Node-only imports: it is bundled into client components.
 */
import type { MonitorIncidentSummary } from '@/lib/monitor-incidents'

/** Server → client events. */
export const RealtimeEvents = {
  heartbeat: 'heartbeat',
  heartbeatList: 'heartbeatList',
  importantHeartbeatList: 'importantHeartbeatList',
  monitorList: 'monitorList',
  updateMonitorIntoList: 'updateMonitorIntoList',
  deleteMonitorFromList: 'deleteMonitorFromList',
  uptime: 'uptime',
  avgPing: 'avgPing',
  certInfo: 'certInfo',
  maintenanceList: 'maintenanceList',
  notificationList: 'notificationList',
  monitorIncident: 'monitorIncident',
  info: 'info',
} as const

export type RealtimeEvent = (typeof RealtimeEvents)[keyof typeof RealtimeEvents]

/** Client → server events. */
export const RealtimeClientEvents = {
  joinOrg: 'joinOrg',
  leaveOrg: 'leaveOrg',
} as const

/** Room every member of an organization joins. */
export const orgRoom = (organizationId: string | number) => `org:${organizationId}`

// ---- Payloads -------------------------------------------------------------------------------

/** Ids travel as strings: Postgres uses numbers, MongoDB strings; the client never cares. */
export type RealtimeId = string

export type RealtimeHeartbeatStatus = 'up' | 'down' | 'pending' | 'maintenance'

export type RealtimeRange = '24h' | '30d' | '1y'

/** A heartbeat as sent over the wire (subset of the `heartbeats` collection). */
export interface RealtimeHeartbeat {
  monitor: RealtimeId
  status: RealtimeHeartbeatStatus
  /** ISO timestamp. */
  time: string
  ping?: number | null
  msg?: string | null
  important?: boolean | null
  duration?: number | null
}

/** The slice of a monitor the dashboard list needs (mirrors `MonitorSummary` in the store). */
export interface RealtimeMonitor {
  id: RealtimeId
  name: string
  type: string
  active: boolean
  interval: number
  url?: string | null
  hostname?: string | null
  parent?: RealtimeId | null
  organization?: RealtimeId | null
  /** Resolved tags (name + colour) with the monitor's value. */
  tags?: RealtimeTag[]
}

export interface RealtimeTag {
  id: RealtimeId
  name: string
  color: string | null
  value: string | null
}

export interface RealtimePayloads {
  /** Initial list of monitors (active and paused) of one organization. */
  monitorList: { organizationId: RealtimeId; monitors: RealtimeMonitor[] }
  /** A monitor was created or edited. */
  updateMonitorIntoList: { organizationId: RealtimeId; monitor: RealtimeMonitor }
  /** A monitor was deleted. */
  deleteMonitorFromList: { organizationId: RealtimeId; monitorId: RealtimeId }
  /** Recent heartbeats of one monitor, oldest → newest (replaces what the client has). */
  heartbeatList: {
    organizationId: RealtimeId
    monitorId: RealtimeId
    heartbeats: RealtimeHeartbeat[]
  }
  /** Recent important (status-transition) heartbeats of one monitor, oldest → newest. */
  importantHeartbeatList: {
    organizationId: RealtimeId
    monitorId: RealtimeId
    heartbeats: RealtimeHeartbeat[]
  }
  /** One new heartbeat. */
  heartbeat: { organizationId: RealtimeId; monitorId: RealtimeId; heartbeat: RealtimeHeartbeat }
  /** Uptime ratio 0..1 over `range`. */
  uptime: { organizationId: RealtimeId; monitorId: RealtimeId; range: RealtimeRange; value: number }
  /** Average ping in ms over `range` (null without data). */
  avgPing: {
    organizationId: RealtimeId
    monitorId: RealtimeId
    range: RealtimeRange
    value: number | null
  }
  /** TLS certificate info of a monitor (shape owned by the cert-expiry issue). */
  certInfo: { organizationId: RealtimeId; monitorId: RealtimeId; info: unknown }
  /** Maintenance windows of an organization (shape owned by the maintenance issue). */
  maintenanceList: { organizationId: RealtimeId; items: unknown[] }
  /** Notification providers of an organization (shape owned by the notifications issue). */
  notificationList: { organizationId: RealtimeId; items: unknown[] }
  /** A monitor incident was opened, acknowledged, resolved or published (#100). */
  monitorIncident: { organizationId: RealtimeId; incident: MonitorIncidentSummary }
  /** Server information, sent once per connection. */
  info: { version: string; serverTime: string }
}

/** Typed server → client event map for `socket.io` / `socket.io-client`. */
export type ServerToClientEvents = {
  [E in keyof RealtimePayloads]: (payload: RealtimePayloads[E]) => void
}

export type JoinOrgAck = { ok: true } | { ok: false; error: string }

/** Typed client → server event map. */
export interface ClientToServerEvents {
  joinOrg: (organizationId: RealtimeId, ack?: (result: JoinOrgAck) => void) => void
  leaveOrg: (organizationId: RealtimeId) => void
}
