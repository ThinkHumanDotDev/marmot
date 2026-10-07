/** Client-side calls for the organization audit log (`/api/orgs/:orgId/audit-logs`). */
import { api } from '@/lib/api'
import type { AuditEventRecord } from '@/server/audit/bus'
import type { AuditFilters, AuditPage } from '@/server/audit/query'

export type { AuditEventRecord, AuditFilters, AuditPage }

type Id = string | number

/** Query string of `filters` (empty values left out). */
export function auditQuery(filters: AuditFilters, extra: Record<string, string> = {}): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries({ ...filters, ...extra })) {
    if (value !== undefined && value !== null && value !== '') params.set(key, String(value))
  }
  const query = params.toString()
  return query ? `?${query}` : ''
}

export const auditLogApi = {
  list: (orgId: Id, filters: AuditFilters, page = 1) =>
    api.get<AuditPage>(
      `/api/orgs/${orgId}/audit-logs${auditQuery(filters, { page: String(page) })}`,
    ),
  exportUrl: (orgId: Id, filters: AuditFilters) =>
    `/api/orgs/${orgId}/audit-logs/export${auditQuery(filters)}`,
}
