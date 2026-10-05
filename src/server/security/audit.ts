import type { Payload, PayloadRequest } from 'payload'

import type { OrgId } from '@/access/permissions'
import { childLogger } from '@/lib/logger'

import { requestMeta } from './request'

const log = childLogger('audit')

/**
 * Names of the events the audit log records. Dotted `<subject>.<verb>` so the list page can be
 * filtered with `action: { like: 'member.' }`. Add new actions here so they stay discoverable.
 */
export const AUDIT_ACTIONS = [
  'auth.login',
  'auth.login_failed',
  'auth.rate_limited',
  'auth.forgot_password',
  'member.role_changed',
  'member.removed',
  'invitation.created',
  'invitation.accepted',
  'organization.updated',
  'organization.deleted',
] as const
export type AuditAction = (typeof AUDIT_ACTIONS)[number]

export interface AuditEvent {
  action: AuditAction
  /** User id performing the action; null for anonymous events such as failed logins. */
  actor?: OrgId | null
  /** Organization the event belongs to; null for instance-level events (visible to superadmins). */
  organization?: OrgId | null
  /** What was acted on, e.g. `user:42` or `organization:7`. */
  target?: string | null
  ip?: string | null
  userAgent?: string | null
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

/**
 * Appends one row to `audit-logs`. Writes bypass access control (`overrideAccess: true`); the
 * collection itself refuses every client write. Never throws: an audit failure is logged but must
 * not break the operation being audited.
 */
export async function recordAuditEvent(payload: Payload, event: AuditEvent): Promise<void> {
  const { req, ...rest } = event
  try {
    await payload.create({
      collection: 'audit-logs',
      data: {
        action: rest.action,
        actor: relation(rest.actor) as never,
        organization: relation(rest.organization) as never,
        target: rest.target ?? null,
        ip: rest.ip ?? null,
        userAgent: rest.userAgent ?? null,
        metadata: rest.metadata ?? null,
      },
      depth: 0,
      req,
      overrideAccess: true,
    })
  } catch (error) {
    log.error({ err: error, action: rest.action }, 'failed to record audit event')
  }
}

/**
 * `recordAuditEvent` for collection hooks and route handlers that hold a request: fills `ip` and
 * `userAgent` from its headers (honouring `trustProxy`) and joins its transaction when `req` is a
 * Payload request.
 */
export async function recordRequestAuditEvent(
  payload: Payload,
  request: { headers: Headers },
  event: Omit<AuditEvent, 'ip' | 'userAgent'>,
): Promise<void> {
  const meta = await requestMeta(payload, request)
  await recordAuditEvent(payload, { ...event, ...meta })
}
