/**
 * Client calls of the SLA pages (#156). Targets and reports are written through Payload REST
 * (`orgScoped('sla:manage')` decides who may); share links through the org routes.
 */
import { api } from '@/lib/api'
import type { SlaCalculation, SlaSchedule, SlaWindow } from '@/lib/sla'

type Id = string | number

/** A report as the SLA page lists it. */
export interface SlaReportRowView {
  id: string
  name: string
  targetIds: string[]
  schedule: SlaSchedule
  recipients: string[]
  lastSentAt: string | null
  lastError: string | null
}

export interface ShareRowView {
  id: string
  from: string
  to: string
  createdAt: string
  revokedAt: string | null
}

/**
 * Relationship value for an id the page passed as a string: Postgres ids are numbers and Payload
 * refuses `"1"` for them; MongoDB ids (24 hex characters) stay strings.
 */
export const ref = (id: Id): Id =>
  typeof id === 'string' && /^\d{1,15}$/.test(id) ? Number(id) : id

export interface TargetInput {
  monitor: string
  target: number
  period: SlaWindow
  calculation: SlaCalculation
  excludeMaintenance: boolean
}

export interface ReportInput {
  name: string
  targets: string[]
  schedule: SlaSchedule
  recipients: string[]
}

type Doc = { id: Id } & Record<string, unknown>

const query = { depth: 0 }

const targetBody = (input: TargetInput) => ({ ...input, monitor: ref(input.monitor) })

const reportBody = (input: ReportInput) => ({
  name: input.name,
  targets: input.targets.map(ref),
  schedule: input.schedule,
  recipients: input.recipients.map((email) => ({ email })),
})

export const toReportRowView = (doc: Doc): SlaReportRowView => ({
  id: String(doc.id),
  name: String(doc.name ?? ''),
  targetIds: ((doc.targets as unknown[] | null | undefined) ?? []).map((t) =>
    String(typeof t === 'object' && t !== null ? (t as { id: Id }).id : t),
  ),
  schedule: (doc.schedule as SlaSchedule) ?? 'none',
  recipients: ((doc.recipients as { email?: string }[] | null | undefined) ?? []).map((r) =>
    String(r.email ?? ''),
  ),
  lastSentAt: (doc.lastSentAt as string | null | undefined) ?? null,
  lastError: (doc.lastError as string | null | undefined) ?? null,
})

export const slaApi = {
  createTarget: (orgId: Id, input: TargetInput) =>
    api.post<{ doc: Doc }>(
      '/api/sla-targets',
      { ...targetBody(input), organization: ref(orgId) },
      { query },
    ),
  updateTarget: (id: Id, input: TargetInput) =>
    api.patch<{ doc: Doc }>(`/api/sla-targets/${id}`, targetBody(input), { query }),
  removeTarget: (id: Id) => api.delete<unknown>(`/api/sla-targets/${id}`),

  createReport: async (orgId: Id, input: ReportInput) =>
    toReportRowView(
      (
        await api.post<{ doc: Doc }>(
          '/api/sla-reports',
          { ...reportBody(input), organization: ref(orgId) },
          { query },
        )
      ).doc,
    ),
  updateReport: async (id: Id, input: ReportInput) =>
    toReportRowView(
      (await api.patch<{ doc: Doc }>(`/api/sla-reports/${id}`, reportBody(input), { query })).doc,
    ),
  removeReport: (id: Id) => api.delete<unknown>(`/api/sla-reports/${id}`),

  listShares: (orgId: Id, reportId: Id) =>
    api.get<{ docs: ShareRowView[] }>(`/api/orgs/${orgId}/sla/reports/${reportId}/shares`),
  createShare: (orgId: Id, reportId: Id, range: { from: string; to: string }) =>
    api.post<{ doc: ShareRowView; url: string; token: string }>(
      `/api/orgs/${orgId}/sla/reports/${reportId}/shares`,
      range,
    ),
  revokeShare: (orgId: Id, reportId: Id, shareId: Id) =>
    api.delete<{ doc: ShareRowView }>(
      `/api/orgs/${orgId}/sla/reports/${reportId}/shares/${shareId}`,
    ),
}
