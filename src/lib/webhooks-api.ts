/** Client-side calls for outbound webhooks (`/api/orgs/:orgId/webhooks`). */
import { api } from '@/lib/api'
import type { WebhookDeliveryRow, WebhookEndpointRow } from '@/lib/webhooks'

type Id = string | number

export interface WebhookEndpointInput {
  url: string
  description?: string | null
  events: string[]
  active?: boolean
}

export interface WebhookDeliveryPage {
  docs: WebhookDeliveryRow[]
  page: number
  totalPages: number
  totalDocs: number
}

const base = (orgId: Id) => `/api/orgs/${orgId}/webhooks`

export const webhooksApi = {
  /** The signing `secret` is only ever returned by `create` and `rotateSecret`. */
  create: (orgId: Id, data: WebhookEndpointInput) =>
    api.post<{ doc: WebhookEndpointRow; secret: string }>(base(orgId), { ...data }),
  update: (orgId: Id, id: Id, data: Partial<WebhookEndpointInput>) =>
    api.patch<{ doc: WebhookEndpointRow }>(`${base(orgId)}/${id}`, { ...data }),
  remove: (orgId: Id, id: Id) => api.delete<{ deleted: string }>(`${base(orgId)}/${id}`),
  rotateSecret: (orgId: Id, id: Id) =>
    api.post<{ doc: WebhookEndpointRow; secret: string }>(`${base(orgId)}/${id}/rotate-secret`),
  test: (orgId: Id, id: Id) =>
    api.post<{ delivery: WebhookDeliveryRow | null }>(`${base(orgId)}/${id}/test`),
  deliveries: (orgId: Id, id: Id, page = 1) =>
    api.get<WebhookDeliveryPage>(`${base(orgId)}/${id}/deliveries`, { query: { page } }),
  redeliver: (orgId: Id, id: Id, deliveryId: Id) =>
    api.post<{ delivery: WebhookDeliveryRow | null }>(
      `${base(orgId)}/${id}/deliveries/${deliveryId}/redeliver`,
    ),
}
