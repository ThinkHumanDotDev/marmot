import type { Payload, PayloadRequest } from 'payload'

import type { OrgId } from '@/access/permissions'
import { afterCommit } from '@/db/after-commit'
import { childLogger } from '@/lib/logger'
import type { AuditLog } from '@/payload-types'
import type { AuditAction, AuditActorType, AuditEntityType } from '@/server/audit/actions'
import { auditListenerCount, emitAuditEvent, type AuditEventRecord } from '@/server/audit/bus'
import { actorFromRequest, auditHeaders, type AuditActor } from '@/server/audit/context'
import { redactMetadata, type JsonValue } from '@/server/audit/diff'

import { requestMeta } from './request'

export { AUDIT_ACTIONS, type AuditAction } from '@/server/audit/actions'

const log = childLogger('audit')

export interface AuditEvent {
  action: AuditAction
  /** User id performing the action; null for anonymous events such as failed logins. */
  actor?: OrgId | null
  /** Kind of actor. Defaults to `user` when `actor` is set, otherwise `system`. */
  actorType?: AuditActorType
  /** User or API key id; defaults to `actor`. */
  actorId?: string | null
  /** Email or key name, kept when the actor is deleted later. */
  actorLabel?: string | null
  /** Organization the event belongs to; null for instance-level events (visible to superadmins). */
  organization?: OrgId | null
  /** What was acted on, e.g. `user:42` or `organization:7`. Defaults to `<entityType>:<entityId>`. */
  target?: string | null
  entityType?: AuditEntityType | null
  entityId?: OrgId | null
  /** Name of the entity at the time of the event (monitor name, channel name …). */
  entityLabel?: string | null
  /** Paths that changed (updates). */
  changedFields?: string[] | null
  /** Redacted values before / after the change (see `src/server/audit/diff.ts`). */
  before?: Record<string, JsonValue> | null
  after?: Record<string, JsonValue> | null
  ip?: string | null
  userAgent?: string | null
  /** Extra context; secret keys are redacted before the row is written. */
  metadata?: Record<string, unknown> | null
  /**
   * Request whose transaction the row should join (collection hooks). Leave out when the request's
   * transaction may already have been rolled back, e.g. from `afterError`.
   */
  req?: PayloadRequest
}

/** `collection:id` label used in `target`. */
export const auditTarget = (collection: string, id: OrgId): string => `${collection}:${String(id)}`

const relation = (id: OrgId | null | undefined) => (id === undefined || id === null ? null : id)

const relationString = (value: unknown): string | null => {
  if (value === null || value === undefined) return null
  if (typeof value === 'object') {
    const id = (value as { id?: unknown }).id
    return id === undefined || id === null ? null : String(id)
  }
  return String(value)
}

const jsonRecord = (value: unknown): Record<string, JsonValue> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, JsonValue>)
    : null

/** The stored row as listeners and the API receive it (ids as strings). */
export function toAuditEventRecord(doc: AuditLog): AuditEventRecord {
  return {
    id: String(doc.id),
    action: doc.action,
    actorType: (doc.actorType ?? (doc.actor ? 'user' : 'system')) as AuditActorType,
    actorId: doc.actorRef ?? relationString(doc.actor),
    actorLabel:
      doc.actorLabel ??
      (doc.actor && typeof doc.actor === 'object' ? (doc.actor.email ?? null) : null),
    organization: relationString(doc.organization),
    entityType: doc.entityType ?? null,
    entityId: doc.entityId ?? null,
    entityLabel: doc.entityLabel ?? null,
    changedFields: Array.isArray(doc.changedFields)
      ? (doc.changedFields as unknown[]).map(String)
      : [],
    before: jsonRecord(doc.before),
    after: jsonRecord(doc.after),
    metadata: jsonRecord(doc.metadata),
    ip: doc.ip ?? null,
    userAgent: doc.userAgent ?? null,
    createdAt: doc.createdAt,
  }
}

/**
 * Appends one row to `audit-logs` — the single write path of the audit log. Writes bypass access
 * control (`overrideAccess: true`); the collection itself refuses every client write. Joins `req`'s
 * transaction, so the row commits or rolls back with the audited change, and publishes the event
 * to `onAuditEvent` listeners after the commit. Never throws: an audit failure is logged but must
 * not break the operation being audited.
 */
export async function recordAuditEvent(payload: Payload, event: AuditEvent): Promise<void> {
  const { req, ...rest } = event
  const actorType: AuditActorType = rest.actorType ?? (rest.actor ? 'user' : 'system')
  const entityId = rest.entityId === undefined || rest.entityId === null ? null : rest.entityId
  try {
    const doc = (await payload.create({
      collection: 'audit-logs',
      data: {
        action: rest.action,
        actorType,
        actorRef: rest.actorId ?? (rest.actor ? String(rest.actor) : null),
        actorLabel: rest.actorLabel ?? null,
        actor: (actorType === 'user' ? relation(rest.actor) : null) as never,
        organization: relation(rest.organization) as never,
        target:
          rest.target ??
          (rest.entityType && entityId !== null ? `${rest.entityType}:${String(entityId)}` : null),
        entityType: rest.entityType ?? null,
        entityId: entityId === null ? null : String(entityId),
        entityLabel: rest.entityLabel?.slice(0, 200) ?? null,
        changedFields: rest.changedFields ?? null,
        before: rest.before ?? null,
        after: rest.after ?? null,
        ip: rest.ip ?? null,
        userAgent: rest.userAgent ?? null,
        metadata: redactMetadata(rest.metadata),
      },
      depth: 0,
      req,
      overrideAccess: true,
    })) as AuditLog
    if (auditListenerCount() > 0) {
      const record = toAuditEventRecord(doc)
      await afterCommit(req ?? { payload, transactionID: undefined }, () => {
        void emitAuditEvent(payload, record)
      })
    }
  } catch (error) {
    log.error({ err: error, action: rest.action }, 'failed to record audit event')
  }
}

/**
 * `recordAuditEvent` for route handlers that hold a request: fills `ip` and `userAgent` from its
 * headers (honouring `trustProxy`) and joins its transaction when `req` is a Payload request.
 */
export async function recordRequestAuditEvent(
  payload: Payload,
  request: { headers: Headers },
  event: Omit<AuditEvent, 'ip' | 'userAgent'>,
): Promise<void> {
  const meta = await requestMeta(payload, request)
  await recordAuditEvent(payload, { ...event, ...meta })
}

/** Actor columns of a row (`actor`, `actorType`, `actorId`, `actorLabel`). */
export const actorFields = (actor: AuditActor) => ({
  actor: actor.userId,
  actorType: actor.type,
  actorId: actor.id,
  actorLabel: actor.label,
})

/**
 * `recordAuditEvent` from inside a Payload operation (collection and global hooks): the actor
 * comes from `req` (`actorFromRequest`), the IP address and user agent from the client request
 * behind it (`auditHeaders`), and the row joins `req`'s transaction.
 */
export async function recordAuditEventFromReq(
  req: PayloadRequest,
  event: Omit<AuditEvent, 'req' | 'ip' | 'userAgent'>,
): Promise<void> {
  const meta = await requestMeta(req.payload, { headers: auditHeaders(req) })
  await recordAuditEvent(req.payload, {
    ...actorFields(actorFromRequest(req)),
    ...event,
    ...meta,
    req,
  })
}

/**
 * Instance-level account security event of `user` (`auth.two_factor_enabled`, `auth.login` …)
 * with the client's IP address and user agent. Sign-ins belong to a person, not to one of their
 * organizations, so the row has no organization unless one is given (single sign-on through an
 * organization's connection).
 */
export async function recordUserAuditEvent(
  payload: Payload,
  request: { headers: Headers },
  user: { id: OrgId; email?: string | null },
  action: AuditAction,
  extra: { organization?: OrgId | null; metadata?: Record<string, unknown> | null } = {},
): Promise<void> {
  await recordRequestAuditEvent(payload, request, {
    action,
    actor: user.id,
    actorLabel: user.email ?? null,
    organization: extra.organization ?? null,
    target: auditTarget('users', user.id),
    entityType: 'user',
    entityId: user.id,
    entityLabel: user.email ?? null,
    metadata: extra.metadata ?? null,
  })
}
