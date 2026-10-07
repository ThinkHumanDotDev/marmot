'use client'

import * as React from 'react'

import { heartbeatStatusName } from '@/lib/realtime'
import { selectHeartbeats, useMonitorStore } from '@/stores/monitor-store'

import { HeartbeatBar, type BeatLike } from './heartbeat-bar'

/**
 * Heartbeat bar of the detail page: the server-rendered beats until the realtime store holds this
 * monitor's beats, then the live ring buffer (so "Check now" and scheduled beats appear at once).
 */
export function LiveHeartbeatBar({
  monitorId,
  beats,
  timeZone,
}: {
  monitorId: string
  /** Newest first, from the server render. */
  beats: BeatLike[]
  timeZone?: string
}) {
  const live = useMonitorStore(selectHeartbeats(monitorId))
  const liveBeats = React.useMemo<BeatLike[]>(
    () =>
      live
        .toArray()
        .map((beat) => ({
          id: beat.time,
          status: heartbeatStatusName(beat.status),
          time: beat.time,
          ping: beat.ping,
          msg: beat.msg,
        }))
        .reverse(),
    [live],
  )
  return <HeartbeatBar beats={live.size > 0 ? liveBeats : beats} timeZone={timeZone} />
}
