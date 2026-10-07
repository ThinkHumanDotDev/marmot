/**
 * The one place where heartbeats drive monitor incidents (#100).
 *
 * `registerIncidentListener()` adds a heartbeat listener that applies `incidentActionForBeat` to
 * every important beat (open on DOWN, note MAINTENANCE, auto-resolve on recovery), and a
 * notification gate that runs the reminder policy on resend-interval reminders. Register it before
 * `registerNotificationListener`, so a DOWN beat's incident exists when its notification is built
 * (the message carries the acknowledge link). The worker and the push endpoint both do.
 */
import type { Payload } from 'payload'

import { childLogger } from '@/lib/logger'
import { incidentActionForBeat, type IncidentBeatAction } from '@/lib/monitor-incidents'
import type { MonitorIncident } from '@/payload-types'
import { registerHeartbeatListener, type HeartbeatEvent } from '@/server/engine/hooks'
import { registerNotificationGate } from '@/server/notifications/gates'

import { publishIncident } from './realtime'
import { getReminderPolicy, isReminderBeat } from './reminders'
import {
  findOpenIncident,
  noteMaintenance,
  openIncident,
  recordReminder,
  resolveIncident,
} from './store'

const log = childLogger('incidents:listener')

export interface IncidentBeatResult {
  action: Exclude<IncidentBeatAction, null>
  incident: MonitorIncident | null
  /** The incident document changed (and was published). */
  changed: boolean
}

const beatTime = (event: HeartbeatEvent): Date => {
  const time = event.heartbeat.time ? new Date(event.heartbeat.time) : new Date()
  return Number.isNaN(time.getTime()) ? new Date() : time
}

/** Applies one heartbeat to the monitor's incident. Exported for tests. */
export async function handleIncidentBeat(
  event: HeartbeatEvent,
): Promise<IncidentBeatResult | null> {
  const { payload, monitor, heartbeat } = event
  // A beat held while the worker itself was offline (#148), or deferred by the check (#142), says
  // nothing about the monitor.
  if (event.checkerOffline || event.deferred) return null
  const action = incidentActionForBeat({ status: heartbeat.status, important: heartbeat.important })
  if (!action) return null
  const at = beatTime(event)

  if (action === 'open') {
    const { incident, created } = await openIncident(payload, {
      monitor,
      cause: heartbeat.msg,
      startedAt: at,
    })
    if (created) {
      log.info({ monitorId: monitor.id, incidentId: incident.id }, 'incident opened')
      await publishIncident(payload, incident)
    }
    return { action, incident, changed: created }
  }

  const open = await findOpenIncident(payload, monitor.id)
  if (!open) return { action, incident: null, changed: false }

  const updated =
    action === 'maintenance'
      ? await noteMaintenance(payload, open, at)
      : await resolveIncident(payload, open, { auto: true, at })
  if (action === 'resolve') {
    log.info({ monitorId: monitor.id, incidentId: open.id }, 'incident resolved automatically')
  }
  await publishIncident(payload, updated)
  return { action, incident: updated, changed: true }
}

/**
 * Notification gate: reminders go through the reminder policy; the reminders that pass are counted
 * on the incident. Every other beat passes untouched.
 */
export async function incidentReminderGate(event: HeartbeatEvent): Promise<boolean> {
  if (event.checkerOffline || event.deferred || !isReminderBeat(event)) return true
  const incident = await findOpenIncident(event.payload, event.monitor.id)
  // The beat's own time, so the backoff measures the same clock as the beats it spaces.
  const now = beatTime(event)
  const send = await getReminderPolicy()({ event, incident, now })
  if (send && incident) await recordReminder(event.payload, incident, now)
  if (!send) {
    log.debug({ monitorId: event.monitor.id, incidentId: incident?.id }, 'reminder held back')
  }
  return send
}

/** Hook incidents into the heartbeat pipeline. Returns the function that unhooks them. */
export function registerIncidentListener(_payload?: Payload): () => void {
  const offBeat = registerHeartbeatListener(async (event) => {
    try {
      await handleIncidentBeat(event)
    } catch (err) {
      log.error({ err, monitorId: event.monitor.id }, 'failed to update the monitor incident')
    }
  })
  const offGate = registerNotificationGate(incidentReminderGate)
  log.info('incident heartbeat listener registered')
  return () => {
    offBeat()
    offGate()
  }
}
