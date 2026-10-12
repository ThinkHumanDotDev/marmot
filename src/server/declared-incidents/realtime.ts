import type { Payload } from 'payload'

import type { DeclaredIncidentSummary } from '@/lib/declared-incidents'
import { childLogger } from '@/lib/logger'
import type { DeclaredIncident } from '@/payload-types'
import { emitDeclaredIncident } from '@/server/realtime/emitter'

import { relId } from './ids'
import { serializeDeclaredIncident } from './store'

const log = childLogger('declared-incidents:realtime')

/** Serializes the incident and publishes it to its organization's room. Never throws. */
export async function publishDeclaredIncident(
  payload: Payload,
  doc: DeclaredIncident,
): Promise<DeclaredIncidentSummary | null> {
  try {
    const summary = await serializeDeclaredIncident(payload, doc)
    const orgId = relId(doc.organization)
    if (orgId !== null) emitDeclaredIncident(orgId, summary)
    return summary
  } catch (err) {
    log.warn({ err, incidentId: doc.id }, 'failed to publish declared incident')
    return null
  }
}
