/**
 * `afterChange` / `afterDelete` hooks that write `<entity>.created|updated|deleted` audit rows for a
 * collection. One factory for every organization-scoped collection, so coverage is a one-line
 * change per collection:
 *
 *   hooks: { afterChange: [audit.afterChange], afterDelete: [audit.afterDelete] }
 *
 * Rows join the operation's transaction (`req`), carry the actor from `req` (user, API key or
 * system), the client's IP address and user agent, and — for updates — the changed paths with
 * redacted before/after values. Updates that change only ignored fields (status caches the worker
 * refreshes after every check) write nothing, which keeps high-volume system writes out of the log.
 */
import type {
  CollectionAfterChangeHook,
  CollectionAfterDeleteHook,
  PayloadRequest,
  TypeWithID,
} from 'payload'

import { childLogger } from '@/lib/logger'
import { recordAuditEventFromReq } from '@/server/security/audit'

import type { AuditAction, AuditResourceType } from './actions'
import {
  actorFromRequest,
  AUDIT_METADATA_CONTEXT,
  AUDIT_SKIP_CONTEXT,
  AUDIT_VERB_CONTEXT,
  type AuditId,
} from './context'
import { diffDocs, snapshot } from './diff'

const log = childLogger('audit:hooks')

type Doc = Record<string, unknown>
type Operation = 'create' | 'update' | 'delete'

export interface AuditCollectionOptions {
  entityType: AuditResourceType
  /** Top-level fields that are not audited (server-maintained caches, derived values). */
  ignore?: readonly string[]
  /** Extra secret key names for this document (on top of the name heuristics). */
  secretKeys?: (doc: Doc) => readonly string[]
  /** Display name of the document at the time of the event. */
  label?: (doc: Doc) => string | null | undefined
  /** Organization the row belongs to; defaults to the document's `organization`. */
  organization?: (doc: Doc, operation: Operation) => AuditId | null
  /** Operations to audit (all by default). */
  operations?: readonly Operation[]
  /** Audit writes without a user or API key (scheduled jobs). Default `true`. */
  systemWrites?: boolean
  /**
   * Named verbs for a boolean switch: an update that changes only `field` is recorded as `on` /
   * `off` (`monitor.resumed` / `monitor.paused`) instead of `updated`.
   */
  toggle?: { field: string; on: AuditAction; off: AuditAction }
  /** Action of a delete; defaults to `<entity>.deleted` (`api_key.revoked` for keys). */
  deleteAction?: AuditAction
}

export const relationId = (value: unknown): AuditId | null => {
  if (value === null || value === undefined) return null
  if (typeof value === 'object') {
    const id = (value as { id?: unknown }).id
    return typeof id === 'string' || typeof id === 'number' ? id : null
  }
  return typeof value === 'string' || typeof value === 'number' ? value : null
}

const defaultLabel = (doc: Doc): string | null => {
  for (const key of ['name', 'title', 'email', 'domain', 'slug']) {
    const value = doc[key]
    if (typeof value === 'string' && value.trim()) return value
  }
  return null
}

/** Verb override per entity type, set by callers through `req.context[AUDIT_VERB_CONTEXT]`. */
function contextAction(req: PayloadRequest, entityType: AuditResourceType): AuditAction | null {
  const map = req.context?.[AUDIT_VERB_CONTEXT] as Record<string, AuditAction> | undefined
  return map?.[entityType] ?? null
}

function contextMetadata(req: PayloadRequest): Record<string, unknown> | null {
  const value = req.context?.[AUDIT_METADATA_CONTEXT]
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null
}

export function auditCollection(options: AuditCollectionOptions): {
  afterChange: CollectionAfterChangeHook
  afterDelete: CollectionAfterDeleteHook
} {
  const {
    entityType,
    ignore = [],
    operations = ['create', 'update', 'delete'],
    systemWrites = true,
  } = options
  const label = (doc: Doc) => (options.label ?? defaultLabel)(doc) ?? null
  const organization = (doc: Doc, operation: Operation) =>
    options.organization ? options.organization(doc, operation) : relationId(doc.organization)
  const diffOptions = (doc: Doc) => ({ ignore, secretKeys: options.secretKeys?.(doc) ?? [] })

  const skip = (req: PayloadRequest, operation: Operation): boolean => {
    if (req.context?.[AUDIT_SKIP_CONTEXT]) return true
    if (!operations.includes(operation)) return true
    return !systemWrites && actorFromRequest(req).type === 'system'
  }

  const afterChange: CollectionAfterChangeHook = async ({ doc, previousDoc, operation, req }) => {
    const op: Operation = operation === 'create' ? 'create' : 'update'
    if (skip(req, op)) return doc
    try {
      const current = doc as Doc
      if (op === 'create') {
        await recordAuditEventFromReq(req, {
          action: contextAction(req, entityType) ?? (`${entityType}.created` as AuditAction),
          organization: organization(current, op),
          entityType,
          entityId: (doc as TypeWithID).id,
          entityLabel: label(current),
          after: snapshot(current, diffOptions(current)),
          metadata: contextMetadata(req),
        })
        return doc
      }

      const previous = (previousDoc ?? {}) as Doc
      // Compare only fields the updated document carries: fields hidden from the requester by
      // field-level read access are missing from `doc` and must not read as "removed".
      const comparable: Doc = {}
      for (const key of Object.keys(current)) comparable[key] = previous[key]
      const diff = diffDocs(comparable, current, diffOptions(current))
      if (diff.changedFields.length === 0) return doc

      let action = contextAction(req, entityType) ?? (`${entityType}.updated` as AuditAction)
      const toggle = options.toggle
      if (toggle && diff.changedFields.length === 1 && diff.changedFields[0] === toggle.field) {
        action = current[toggle.field] ? toggle.on : toggle.off
      }
      await recordAuditEventFromReq(req, {
        action,
        organization: organization(current, op),
        entityType,
        entityId: (doc as TypeWithID).id,
        entityLabel: label(current) ?? label(previous),
        changedFields: diff.changedFields,
        before: diff.before,
        after: diff.after,
        metadata: contextMetadata(req),
      })
    } catch (err) {
      log.error({ err, entityType }, 'failed to audit change')
    }
    return doc
  }

  const afterDelete: CollectionAfterDeleteHook = async ({ doc, req }) => {
    if (skip(req, 'delete')) return doc
    try {
      const current = doc as Doc
      await recordAuditEventFromReq(req, {
        action: options.deleteAction ?? (`${entityType}.deleted` as AuditAction),
        organization: organization(current, 'delete'),
        entityType,
        entityId: (doc as TypeWithID).id,
        entityLabel: label(current),
        before: snapshot(current, diffOptions(current)),
        metadata: contextMetadata(req),
      })
    } catch (err) {
      log.error({ err, entityType }, 'failed to audit delete')
    }
    return doc
  }

  return { afterChange, afterDelete }
}
