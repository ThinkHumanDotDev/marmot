import { api } from '@/lib/api'
import type { MaintenanceFormValues } from '@/lib/validation/maintenance'
import type { MaintenanceSummary } from '@/server/maintenance/serialize'

export type { MaintenanceSummary }

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

const base = (orgId: string | number) => `/api/orgs/${encodeURIComponent(String(orgId))}/maintenance`
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
}

/** `2026-01-31T22:00` (wall-clock) or an ISO instant → readable text in the viewer's locale. */
export function formatInstant(iso: string | null | undefined): string {
  if (!iso) return ''
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString()
}

export function formatWindow(window: { start: string; end: string } | null): string {
  if (!window) return ''
  const start = new Date(window.start)
  const end = new Date(window.end)
  const sameDay = start.toDateString() === end.toDateString()
  return `${start.toLocaleString()} – ${sameDay ? end.toLocaleTimeString() : end.toLocaleString()}`
}
