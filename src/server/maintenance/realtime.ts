import type { Payload } from 'payload'

import type { OrgId } from '@/access/permissions'
import { childLogger } from '@/lib/logger'
import { emitMaintenanceList } from '@/server/realtime/emitter'
import { listOrgMaintenance, type MaintenanceSummary } from './serialize'

const log = childLogger('maintenance:realtime')

/**
 * Publish the organization's full maintenance list (`maintenanceList` event, items are
 * `MaintenanceSummary[]`). Called by the collection hooks after edits and by the status job when a
 * status flipped. Never throws: live updates are best effort.
 */
export async function emitOrgMaintenanceList(
  payload: Payload,
  orgId: OrgId,
): Promise<MaintenanceSummary[] | null> {
  try {
    const items = await listOrgMaintenance(payload, orgId, { overrideAccess: true })
    emitMaintenanceList(orgId, items)
    return items
  } catch (err) {
    log.warn({ err, orgId }, 'failed to publish the maintenance list')
    return null
  }
}
