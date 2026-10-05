/**
 * Socket.IO event names shared by the realtime server, the worker emitter and the client.
 * Names follow Uptime Kuma's vocabulary so the mental model carries over.
 */
export const RealtimeEvents = {
  heartbeat: 'heartbeat',
  heartbeatList: 'heartbeatList',
  importantHeartbeatList: 'importantHeartbeatList',
  monitorList: 'monitorList',
  uptime: 'uptime',
  avgPing: 'avgPing',
  certInfo: 'certInfo',
  maintenanceList: 'maintenanceList',
  notificationList: 'notificationList',
  info: 'info',
} as const

export type RealtimeEvent = (typeof RealtimeEvents)[keyof typeof RealtimeEvents]

/** Room every member of an organization joins. */
export const orgRoom = (organizationId: string | number) => `org:${organizationId}`
