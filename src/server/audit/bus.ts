/**
 * In-process listener registry for audit events. `recordAuditEvent` publishes every row here once
 * the transaction that wrote it has committed (rows of rolled-back operations are never published).
 * Outbound webhooks (#157) and similar integrations subscribe with `onAuditEvent` instead of adding
 * hooks to every collection.
 *
 * Listeners run asynchronously and never block or fail the audited operation; errors are logged.
 * The registry is per process: subscribe where the integration runs (web and worker both write
 * audit rows).
 */
import type { Payload } from 'payload'

import { childLogger } from '@/lib/logger'

import type { AuditActorType } from './actions'
import type { JsonValue } from './diff'

const log = childLogger('audit:bus')

/** An audit row as listeners receive it (ids as strings, adapter independent). */
export interface AuditEventRecord {
  id: string
  action: string
  actorType: AuditActorType
  actorId: string | null
  actorLabel: string | null
  organization: string | null
  entityType: string | null
  entityId: string | null
  entityLabel: string | null
  changedFields: string[]
  before: Record<string, JsonValue> | null
  after: Record<string, JsonValue> | null
  metadata: Record<string, JsonValue> | null
  ip: string | null
  userAgent: string | null
  createdAt: string
}

export type AuditListener = (
  event: AuditEventRecord,
  context: { payload: Payload },
) => void | Promise<void>

const REGISTRY = Symbol.for('marmot.audit.listeners')
type GlobalWithRegistry = typeof globalThis & { [REGISTRY]?: Set<AuditListener> }

/** Survives Next.js dev reloads, which re-evaluate this module. */
function listeners(): Set<AuditListener> {
  const scope = globalThis as GlobalWithRegistry
  scope[REGISTRY] ??= new Set()
  return scope[REGISTRY]
}

/** Subscribe to every audit event of this process. Returns an unsubscribe function. */
export function onAuditEvent(listener: AuditListener): () => void {
  listeners().add(listener)
  return () => {
    listeners().delete(listener)
  }
}

/** Number of subscribed listeners (cheap check before building an event). */
export const auditListenerCount = (): number => listeners().size

/** Calls every listener; resolves once all have settled. Never throws. */
export async function emitAuditEvent(payload: Payload, event: AuditEventRecord): Promise<void> {
  const current = [...listeners()]
  await Promise.all(
    current.map(async (listener) => {
      try {
        await listener(event, { payload })
      } catch (err) {
        log.error({ err, action: event.action }, 'audit listener failed')
      }
    }),
  )
}
