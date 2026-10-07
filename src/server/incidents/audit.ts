import type { Payload } from 'payload'

import type { MonitorIncidentSummary } from '@/lib/monitor-incidents'
import type { AuditAction } from '@/server/audit/actions'
import { actorFromRequest } from '@/server/audit/context'
import { actorFields, recordRequestAuditEvent } from '@/server/security/audit'

/**
 * Audit row for a member's action on a monitor incident (`acknowledge`, `resolve`, `publish`).
 * Incident rows themselves are written by the engine and not audited (`src/collections/audit.ts`);
 * what the audit log keeps is who acted. `user` is `null` for an acknowledgement through the signed
 * link of a notification by someone who is not signed in as a member; an API key principal is
 * recorded as the key.
 */
export async function auditIncidentAction(
  payload: Payload,
  request: { headers: Headers },
  summary: MonitorIncidentSummary,
  action: Extract<AuditAction, `monitor_incident.${string}`>,
  user: { id: string | number; email?: string | null } | null,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  await recordRequestAuditEvent(payload, request, {
    // A user, an API key principal (`user.apiKey`), or the system when nobody is signed in.
    ...actorFields(actorFromRequest({ user })),
    action,
    organization: summary.organizationId,
    entityType: 'monitor_incident',
    entityId: summary.id,
    entityLabel: summary.monitor?.name ?? null,
    before: null,
    after: { status: summary.status },
    metadata: { monitorId: summary.monitor?.id ?? null, ...metadata },
  })
}
