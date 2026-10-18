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
  showThresholdState: boolean
  source: MetricSource
  monitor: string | null
  visible: boolean
  statusPages: string[]
  order: number
}

const base = (orgId: Id) => `/api/orgs/${orgId}/metrics`

/** The metrics of the organization and those a status page shows, in its order (#280). */
export interface PageMetricsResponse {
  metrics: MetricRow[]
  selected: string[]
}

export const metricsApi = {
  create: (orgId: Id, data: MetricInput) => api.post<{ doc: MetricRow }>(base(orgId), { ...data }),
  update: (orgId: Id, id: Id, data: Partial<MetricInput>) =>
    api.patch<{ doc: MetricRow }>(`${base(orgId)}/${id}`, { ...data }),
  remove: (orgId: Id, id: Id) => api.delete<{ deleted: string }>(`${base(orgId)}/${id}`),
  pageMetrics: (orgId: Id, pageId: Id) =>
    api.get<PageMetricsResponse>(`/api/orgs/${orgId}/status-pages/${pageId}/metrics`),
  setPageMetrics: (orgId: Id, pageId: Id, metrics: string[]) =>
    api.put<PageMetricsResponse>(`/api/orgs/${orgId}/status-pages/${pageId}/metrics`, {
      metrics,
    }),
}
