/** Client-side calls for custom metrics (`/api/orgs/:orgId/metrics`, #155). */
import { api } from '@/lib/api'
import type {
  MetricAggregation,
  MetricRow,
  MetricSource,
  MetricThresholds,
  MetricView,
} from '@/lib/metrics'

type Id = string | number

export interface MetricInput {
  name: string
  description: string | null
  suffix: string | null
  decimals: number
  aggregation: MetricAggregation
  defaultView: MetricView
  thresholds: MetricThresholds
  source: MetricSource
  monitor: string | null
  visible: boolean
  statusPages: string[]
  order: number
}

const base = (orgId: Id) => `/api/orgs/${orgId}/metrics`

export const metricsApi = {
  create: (orgId: Id, data: MetricInput) => api.post<{ doc: MetricRow }>(base(orgId), { ...data }),
  update: (orgId: Id, id: Id, data: Partial<MetricInput>) =>
    api.patch<{ doc: MetricRow }>(`${base(orgId)}/${id}`, { ...data }),
  remove: (orgId: Id, id: Id) => api.delete<{ deleted: string }>(`${base(orgId)}/${id}`),
}
