import type { Payload } from 'payload'

import type { MonitorIncidentSummary } from '@/lib/monitor-incidents'
import { childLogger } from '@/lib/logger'
import type { MonitorIncident } from '@/payload-types'
import { emitMonitorIncident } from '@/server/realtime/emitter'

import { relId, serializeIncident } from './store'

const log = childLogger('incidents:realtime')

/** Serializes an incident and publishes it to its organization's room. Never throws. */
export async function publishIncident(
  payload: Payload,
  doc: MonitorIncident,
): Promise<MonitorIncidentSummary | null> {
  try {
    const summary = await serializeIncident(payload, doc)
    const orgId = relId(doc.organization)
    if (orgId !== null) emitMonitorIncident(orgId, summary)
    return summary
  } catch (err) {
    log.warn({ err, incidentId: doc.id }, 'failed to publish incident')
    return null
  }
}
