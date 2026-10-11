/** Client-side calls for OpenTelemetry collectors (`/api/orgs/:orgId/otel-collectors`, #99). */
import { api } from '@/lib/api'
import type { OtelCollectorRow } from '@/lib/otel'

type Id = string | number

export interface OtelCollectorInput {
  name: string
  endpoint: string
  /** Replaces every header; `value: null` keeps the stored value of that name. */
  headers?: { name: string; value: string | null }[]
  active?: boolean
  default?: boolean
}

const base = (orgId: Id) => `/api/orgs/${orgId}/otel-collectors`

export const otelApi = {
  create: (orgId: Id, data: OtelCollectorInput) =>
    api.post<{ doc: OtelCollectorRow }>(base(orgId), { ...data }),
  update: (orgId: Id, id: Id, data: Partial<OtelCollectorInput>) =>
    api.patch<{ doc: OtelCollectorRow }>(`${base(orgId)}/${id}`, { ...data }),
  remove: (orgId: Id, id: Id) => api.delete<{ deleted: string }>(`${base(orgId)}/${id}`),
  test: (orgId: Id, id: Id) =>
    api.post<{ ok: boolean; status: number | null; error: string | null }>(
      `${base(orgId)}/${id}/test`,
    ),
}
