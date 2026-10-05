'use client'

import * as React from 'react'

import { toStoreHeartbeat, toStoreMonitor } from '@/lib/realtime'
import { getSocket } from '@/lib/socket'
import {
  RealtimeClientEvents,
  RealtimeEvents,
  type RealtimePayloads,
} from '@/server/realtime/events'
import { useMonitorStore } from '@/stores/monitor-store'

export type ConnectionState = 'connecting' | 'connected' | 'disconnected'

interface RealtimeContextValue {
  state: ConnectionState
  /** Organization whose events are written into the store. */
  organizationId: string
  /** Server info from the `info` event. */
  server?: { version: string; serverTime: string }
}

const RealtimeContext = React.createContext<RealtimeContextValue | null>(null)

/** Connection state of the shared socket (for "Live" indicators). */
export function useRealtimeConnection(): RealtimeContextValue {
  const value = React.useContext(RealtimeContext)
  return value ?? { state: 'disconnected', organizationId: '' }
}

interface SocketProviderProps {
  organizationId: string | number
  children: React.ReactNode
}

/**
 * Connects the shared socket once the organization layout mounts, joins the organization room and
 * streams every realtime event of that organization into `useMonitorStore`. Events of other
 * organizations the user belongs to (the server joins all of their rooms) are ignored, and the
 * store is reset when the organization changes.
 */
export function SocketProvider({ organizationId, children }: SocketProviderProps) {
  const orgId = String(organizationId)
  const [state, setState] = React.useState<ConnectionState>('connecting')
  const [server, setServer] = React.useState<RealtimeContextValue['server']>()

  React.useEffect(() => {
    const socket = getSocket()
    const store = () => useMonitorStore.getState()
    const mine = (payload: { organizationId: string }) => payload.organizationId === orgId

    const onConnect = () => {
      setState('connected')
      socket.emit(RealtimeClientEvents.joinOrg, orgId)
    }
    const onDisconnect = () => setState('disconnected')
    const onConnectError = () => setState('disconnected')

    const onInfo = (payload: RealtimePayloads['info']) => setServer(payload)
    const onMonitorList = (payload: RealtimePayloads['monitorList']) => {
      if (mine(payload)) store().setMonitors(payload.monitors.map(toStoreMonitor))
    }
    const onMonitorUpdated = (payload: RealtimePayloads['updateMonitorIntoList']) => {
      if (mine(payload)) store().upsertMonitor(toStoreMonitor(payload.monitor))
    }
    const onMonitorDeleted = (payload: RealtimePayloads['deleteMonitorFromList']) => {
      if (mine(payload)) store().removeMonitor(payload.monitorId)
    }
    const onHeartbeatList = (payload: RealtimePayloads['heartbeatList']) => {
      if (mine(payload)) {
        store().setHeartbeatList(payload.monitorId, payload.heartbeats.map(toStoreHeartbeat))
      }
    }
    const onImportantHeartbeatList = (payload: RealtimePayloads['importantHeartbeatList']) => {
      if (mine(payload)) {
        store().setImportantHeartbeatList(
          payload.monitorId,
          payload.heartbeats.map(toStoreHeartbeat),
        )
      }
    }
    const onHeartbeat = (payload: RealtimePayloads['heartbeat']) => {
      if (mine(payload)) {
        store().pushHeartbeat({
          ...toStoreHeartbeat(payload.heartbeat),
          monitor: payload.monitorId,
        })
      }
    }
    const onUptime = (payload: RealtimePayloads['uptime']) => {
      if (mine(payload)) store().setUptime(payload.monitorId, payload.range, payload.value)
    }
    const onAvgPing = (payload: RealtimePayloads['avgPing']) => {
      // The store keeps a single average ping per monitor: the 24h figure.
      if (mine(payload) && payload.range === '24h' && typeof payload.value === 'number') {
        store().setAvgPing(payload.monitorId, payload.value)
      }
    }

    socket.on('connect', onConnect)
    socket.on('disconnect', onDisconnect)
    socket.on('connect_error', onConnectError)
    socket.on(RealtimeEvents.info, onInfo)
    socket.on(RealtimeEvents.monitorList, onMonitorList)
    socket.on(RealtimeEvents.updateMonitorIntoList, onMonitorUpdated)
    socket.on(RealtimeEvents.deleteMonitorFromList, onMonitorDeleted)
    socket.on(RealtimeEvents.heartbeatList, onHeartbeatList)
    socket.on(RealtimeEvents.importantHeartbeatList, onImportantHeartbeatList)
    socket.on(RealtimeEvents.heartbeat, onHeartbeat)
    socket.on(RealtimeEvents.uptime, onUptime)
    socket.on(RealtimeEvents.avgPing, onAvgPing)

    if (socket.connected) {
      onConnect()
    } else {
      socket.connect()
    }

    return () => {
      socket.off('connect', onConnect)
      socket.off('disconnect', onDisconnect)
      socket.off('connect_error', onConnectError)
      socket.off(RealtimeEvents.info, onInfo)
      socket.off(RealtimeEvents.monitorList, onMonitorList)
      socket.off(RealtimeEvents.updateMonitorIntoList, onMonitorUpdated)
      socket.off(RealtimeEvents.deleteMonitorFromList, onMonitorDeleted)
      socket.off(RealtimeEvents.heartbeatList, onHeartbeatList)
      socket.off(RealtimeEvents.importantHeartbeatList, onImportantHeartbeatList)
      socket.off(RealtimeEvents.heartbeat, onHeartbeat)
      socket.off(RealtimeEvents.uptime, onUptime)
      socket.off(RealtimeEvents.avgPing, onAvgPing)
      // The next organization starts from a clean store (the socket stays open for reuse).
      store().reset()
    }
  }, [orgId])

  const value = React.useMemo<RealtimeContextValue>(
    () => ({ state, organizationId: orgId, server }),
    [state, orgId, server],
  )

  return <RealtimeContext.Provider value={value}>{children}</RealtimeContext.Provider>
}
