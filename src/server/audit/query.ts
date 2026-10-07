/**
 * Reading the audit log for an organization: filter parsing (shared by the list API, the CSV export
 * and the settings page), the Payload `where`, paging and CSV rendering. Reads always run as the
 * requesting user (`overrideAccess: false`) so the `audit-logs` access rule — `audit-log:read` in
 * the organization, honouring permission overrides — applies on top of the route's own check.
 */
import type { Payload, Where } from 'payload'
import { z } from 'zod'

import type { OrgId } from '@/access/permissions'
import type { AuditLog } from '@/payload-types'
import { toAuditEventRecord } from '@/server/security/audit'

import { AUDIT_ACTIONS, AUDIT_ACTOR_TYPES, AUDIT_ENTITY_TYPES } from './actions'
import type { AuditEventRecord } from './bus'

export const AUDIT_PAGE_SIZE = 50
export const AUDIT_MAX_PAGE_SIZE = 200
/** Upper bound of one CSV export. */
export const AUDIT_EXPORT_MAX_ROWS = 10_000

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/
const dateParam = z.string().refine((value) => !Number.isNaN(Date.parse(value)), 'invalid date')

export const auditFiltersSchema = z.object({
  actorType: z.enum(AUDIT_ACTOR_TYPES).optional(),
  actorId: z.string().trim().min(1).max(64).optional(),
  entityType: z.enum(AUDIT_ENTITY_TYPES).optional(),
  entityId: z.string().trim().min(1).max(64).optional(),
  /** Exact action (`monitor.paused`) or a prefix ending in a dot (`monitor.`). */
  action: z
    .string()
    .trim()
    .regex(/^[a-z_]+(\.[a-z_]*)?$/)
    .optional(),
  /** Inclusive start (ISO instant, or a date meaning 00:00 UTC). */
  from: dateParam.optional(),
  /** Inclusive end (ISO instant, or a date meaning the whole day, UTC). */
  to: dateParam.optional(),
  /** Superadmins only: instance-level rows (sign-ins, instance settings) instead of the org's. */
  scope: z.enum(['organization', 'instance']).optional(),
})

export type AuditFilters = z.infer<typeof auditFiltersSchema>

/** Filters from a query string; unknown or empty parameters are ignored. */
export function parseAuditFilters(
  params: URLSearchParams,
): { ok: true; filters: AuditFilters } | { ok: false; error: string } {
  const raw: Record<string, string> = {}
  for (const key of Object.keys(auditFiltersSchema.shape)) {
    const value = params.get(key)
    if (value !== null && value.trim() !== '') raw[key] = value
  }
  const parsed = auditFiltersSchema.safeParse(raw)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    return { ok: false, error: `${issue?.path.join('.') ?? 'query'}: ${issue?.message ?? ''}` }
  }
  return { ok: true, filters: parsed.data }
}

function endOf(value: string): Date {
  const date = new Date(value)
  return DATE_ONLY.test(value) ? new Date(date.getTime() + 86_400_000 - 1) : date
}

/** Payload `where` for `filters` inside `orgId` (or the instance scope). */
export function auditWhere(orgId: OrgId, filters: AuditFilters): Where {
  const and: Where[] = []
  if (filters.scope === 'instance') {
    and.push({
      or: [{ organization: { equals: null } }, { organization: { exists: false } }],
    })
  } else {
    and.push({ organization: { equals: orgId } })
  }
  if (filters.actorType) {
    const legacy: Where | null =
      filters.actorType === 'user'
        ? { and: [{ actorType: { exists: false } }, { actor: { exists: true } }] }
        : filters.actorType === 'system'
          ? { and: [{ actorType: { exists: false } }, { actor: { exists: false } }] }
          : null
    // Rows written before `actorType` existed (MongoDB keeps them unset) count by their `actor`.
    and.push(
      legacy
        ? { or: [{ actorType: { equals: filters.actorType } }, legacy] }
        : { actorType: { equals: filters.actorType } },
    )
  }
  if (filters.actorId) {
    // Rows written before `actorRef` existed only carry the `actor` relationship.
    and.push({
      or: [{ actorRef: { equals: filters.actorId } }, { actor: { equals: filters.actorId } }],
    })
  }
  if (filters.entityType) and.push({ entityType: { equals: filters.entityType } })
  if (filters.entityId) and.push({ entityId: { equals: filters.entityId } })
  if (filters.action) {
    // A prefix expands to the known actions (`in`), which behaves the same on every adapter.
    const prefix = filters.action
    and.push(
      prefix.endsWith('.')
        ? { action: { in: AUDIT_ACTIONS.filter((action) => action.startsWith(prefix)) } }
        : { action: { equals: prefix } },
    )
  }
  if (filters.from) and.push({ createdAt: { greater_than_equal: new Date(filters.from) } })
  if (filters.to) and.push({ createdAt: { less_than_equal: endOf(filters.to) } })
  return { and }
}

export interface AuditPage {
  docs: AuditEventRecord[]
  page: number
  totalPages: number
  totalDocs: number
  hasNextPage: boolean
}

type ReadUser = Parameters<Payload['find']>[0]['user']

/** One page of the organization's audit log, newest first, read as `user`. */
export async function listAuditEvents(
  payload: Payload,
  user: ReadUser,
  orgId: OrgId,
  filters: AuditFilters,
  { page = 1, limit = AUDIT_PAGE_SIZE }: { page?: number; limit?: number } = {},
): Promise<AuditPage> {
  const result = await payload.find({
    collection: 'audit-logs',
    where: auditWhere(orgId, filters),
    sort: '-createdAt',
    page: Math.max(1, page),
    limit: Math.min(Math.max(1, limit), AUDIT_MAX_PAGE_SIZE),
    depth: 0,
    user,
    overrideAccess: false,
  })
  return {
    docs: (result.docs as AuditLog[]).map(toAuditEventRecord),
    page: result.page ?? page,
    totalPages: result.totalPages,
    totalDocs: result.totalDocs,
    hasNextPage: result.hasNextPage,
  }
}

/** Every matching row up to `AUDIT_EXPORT_MAX_ROWS`, newest first, read as `user`. */
export async function exportAuditEvents(
  payload: Payload,
  user: ReadUser,
  orgId: OrgId,
  filters: AuditFilters,
): Promise<AuditEventRecord[]> {
  const rows: AuditEventRecord[] = []
  for (let page = 1; rows.length < AUDIT_EXPORT_MAX_ROWS; page += 1) {
    const result = await listAuditEvents(payload, user, orgId, filters, {
      page,
      limit: AUDIT_MAX_PAGE_SIZE,
    })
    rows.push(...result.docs)
    if (!result.hasNextPage) break
  }
  return rows.slice(0, AUDIT_EXPORT_MAX_ROWS)
}

export const AUDIT_CSV_COLUMNS = [
  'createdAt',
  'action',
  'actorType',
  'actorId',
  'actorLabel',
  'entityType',
  'entityId',
  'entityLabel',
  'changedFields',
  'before',
  'after',
  'ip',
  'userAgent',
  'metadata',
] as const

/** RFC 4180 field; cells starting with `= + - @` are prefixed so spreadsheets do not run them. */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return ''
  let text = typeof value === 'string' ? value : JSON.stringify(value)
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/** CSV with a header row; before/after/metadata as JSON, changed fields `;`-separated. */
export function auditEventsToCsv(rows: AuditEventRecord[]): string {
  const lines = [AUDIT_CSV_COLUMNS.join(',')]
  for (const row of rows) {
    lines.push(
      AUDIT_CSV_COLUMNS.map((column) =>
        column === 'changedFields' ? csvCell(row.changedFields.join(';')) : csvCell(row[column]),
      ).join(','),
    )
  }
  return `${lines.join('\r\n')}\r\n`
}
