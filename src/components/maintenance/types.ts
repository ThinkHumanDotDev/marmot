import { api } from '@/lib/api'
import type { OccurrenceState, OccurrenceSummary } from '@/lib/maintenance-announcements'
import type { MaintenanceFormValues } from '@/lib/validation/maintenance'
import type { MaintenanceSummary } from '@/server/maintenance/serialize'

export type { MaintenanceSummary, OccurrenceSummary }

export interface MonitorOption {
  id: string
  name: string
  type: string
  parent: string | null
}

export interface StatusPageOption {
  id: string
  title: string
  slug: string
}

const base = (orgId: string | number) =>
  `/api/orgs/${encodeURIComponent(String(orgId))}/maintenance`
const one = (orgId: string | number, id: string) => `${base(orgId)}/${encodeURIComponent(id)}`

/** Client wrapper over `/api/orgs/:orgId/maintenance/**`; every call returns `MaintenanceSummary`. */
export const maintenanceApi = {
  list: async (orgId: string | number) =>
    (await api.get<{ docs: MaintenanceSummary[] }>(base(orgId))).docs,
  create: (orgId: string | number, values: MaintenanceFormValues) =>
    api.post<MaintenanceSummary>(base(orgId), values),
  update: (orgId: string | number, id: string, values: Partial<MaintenanceFormValues>) =>
    api.patch<MaintenanceSummary>(one(orgId, id), values),
  pause: (orgId: string | number, id: string) =>
    api.post<MaintenanceSummary>(`${one(orgId, id)}/pause`),
  resume: (orgId: string | number, id: string) =>
    api.post<MaintenanceSummary>(`${one(orgId, id)}/resume`),
  remove: (orgId: string | number, id: string) =>
    api.delete<{ id: string; deleted: true }>(one(orgId, id)),
  occurrences: async (orgId: string | number, id: string) =>
    (await api.get<{ docs: OccurrenceSummary[] }>(`${one(orgId, id)}/occurrences`)).docs,
  /** Post an update; another status than the current one starts/verifies/completes/cancels. */
  postUpdate: (
    orgId: string | number,
    id: string,
    occurrenceId: string,
    body: { status: OccurrenceState; message?: string },
  ) =>
    api.post<{ occurrence: OccurrenceSummary; maintenance: MaintenanceSummary }>(
      `${one(orgId, id)}/occurrences/${encodeURIComponent(occurrenceId)}/updates`,
      body,
    ),
}
