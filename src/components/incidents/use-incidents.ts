'use client'

import { useTranslations } from 'next-intl'
import * as React from 'react'

import { getSocket } from '@/lib/socket'
import type { MonitorIncidentSummary } from '@/lib/monitor-incidents'
import { humanDuration } from '@/lib/validation/monitor'
import { RealtimeEvents, type RealtimePayloads } from '@/server/realtime/events'

/** "2 hours 5 minutes" (minutes once it is a minute or longer). */
export function useDurationText() {
  const t = useTranslations('common.duration')
  return (seconds: number | null | undefined): string => {
    if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return ''
    const rounded = seconds >= 60 ? Math.round(seconds / 60) * 60 : Math.round(seconds)
    return humanDuration(rounded, (unit, count) => t(unit, { count }))
  }
}

/**
 * Current time, refreshed every `intervalMs` while `active` (ongoing durations). Starts at the
 * server-provided `initial` so the first client render matches the server HTML.
 */
export function useNow(initial: number, active: boolean, intervalMs = 30_000): number {
  const [now, setNow] = React.useState(initial)
  React.useEffect(() => {
    if (!active) return
    const tick = () => setNow(Date.now())
    const first = setTimeout(tick, 0)
    const timer = setInterval(tick, intervalMs)
    return () => {
      clearTimeout(first)
      clearInterval(timer)
    }
  }, [active, intervalMs])
  return now
}

/** Calls `onIncident` for every `monitorIncident` event of the organization. */
export function useIncidentEvents(
  orgId: string | number,
  onIncident: (incident: MonitorIncidentSummary) => void,
): void {
  const callback = React.useRef(onIncident)
  React.useEffect(() => {
    callback.current = onIncident
  })
  React.useEffect(() => {
    const socket = getSocket()
    const handler = (payload: RealtimePayloads['monitorIncident']) => {
      if (payload.organizationId === String(orgId)) callback.current(payload.incident)
    }
    socket.on(RealtimeEvents.monitorIncident, handler)
    return () => {
      socket.off(RealtimeEvents.monitorIncident, handler)
    }
  }, [orgId])
}
