/**
 * Member actions on a monitor incident: acknowledge, resolve, publish to a status page. Route
 * handlers authorise and then call these; each one writes the incident, publishes it over realtime
 * and (acknowledge, resolve) notifies the monitor's channels.
 */
import type { Payload } from 'payload'

import type { MonitorIncidentSummary } from '@/lib/monitor-incidents'
import type { MonitorIncident } from '@/payload-types'

import { enqueueIncidentNotifications } from './notify'
import { publishIncident } from './realtime'
import { acknowledgeIncident, resolveIncident, serializeIncident, type ActorInput } from './store'

async function settle(payload: Payload, doc: MonitorIncident): Promise<MonitorIncidentSummary> {
  return (await publishIncident(payload, doc)) ?? (await serializeIncident(payload, doc))
}

/** Acknowledge (409 unless open), publish, notify `acknowledged`. */
export async function acknowledge(
  payload: Payload,
  incident: MonitorIncident,
  actor: ActorInput,
): Promise<MonitorIncidentSummary> {
  const updated = await acknowledgeIncident(payload, incident, actor)
  const summary = await settle(payload, updated)
  await enqueueIncidentNotifications(payload, updated, 'acknowledged')
  return summary
}

/** Resolve by hand (409 when already resolved), publish, notify `resolved`. */
export async function resolve(
  payload: Payload,
  incident: MonitorIncident,
  actor: ActorInput,
): Promise<MonitorIncidentSummary> {
  const updated = await resolveIncident(payload, incident, { ...actor, auto: false })
  const summary = await settle(payload, updated)
  await enqueueIncidentNotifications(payload, updated, 'resolved')
  return summary
}
