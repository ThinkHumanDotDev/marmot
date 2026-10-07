import { api } from '@/lib/api'
import type { MonitorIncidentSummary } from '@/lib/monitor-incidents'

const one = (orgId: string | number, id: string) =>
  `/api/orgs/${encodeURIComponent(String(orgId))}/monitor-incidents/${encodeURIComponent(id)}`

export interface PublishBody {
  statusPageId: string
  title?: string
  message?: string
}

/** Client wrapper over `/api/orgs/:orgId/monitor-incidents/**` and the signed-link endpoint. */
export const incidentsApi = {
  acknowledge: (orgId: string | number, id: string, note?: string) =>
    api.post<MonitorIncidentSummary>(`${one(orgId, id)}/acknowledge`, note ? { note } : {}),
  resolve: (orgId: string | number, id: string, note?: string) =>
    api.post<MonitorIncidentSummary>(`${one(orgId, id)}/resolve`, note ? { note } : {}),
  publish: (orgId: string | number, id: string, body: PublishBody) =>
    api.post<{ incident: MonitorIncidentSummary; statusPageIncident: { id: string | number } }>(
      `${one(orgId, id)}/publish`,
      { ...body },
    ),
  acknowledgeByLink: (token: string) =>
    api.post<{ status: string }>('/api/incident-ack', { token }),
}
