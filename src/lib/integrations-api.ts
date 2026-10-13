/** Client-side calls for inbound alert integrations (`/api/orgs/:orgId/integrations`, #152). */
import { api } from '@/lib/api'
import type { IntegrationEventRow, IntegrationRow } from '@/lib/inbound-alerts'

type Id = string | number

type RuleInput = Omit<IntegrationRow['rules'][number], 'id'> & { id?: string | null }

export type IntegrationInput = Partial<
  Omit<IntegrationRow, 'id' | 'tokenPrefix' | 'lastEventAt' | 'createdAt' | 'rules'> & {
    rules: RuleInput[]
  }
>

/** Returned by `create` and `rotateToken` only: the token and where it is used. */
export interface IntegrationSecret {
  doc: IntegrationRow
  token: string
  url: string
  email: string | null
}

export interface IntegrationEventPage {
  docs: IntegrationEventRow[]
  page: number
  totalPages: number
  totalDocs: number
}

const base = (orgId: Id) => `/api/orgs/${orgId}/integrations`

export const integrationsApi = {
  create: (orgId: Id, data: IntegrationInput) =>
    api.post<IntegrationSecret>(base(orgId), { ...data }),
  update: (orgId: Id, id: Id, data: IntegrationInput) =>
    api.patch<{ doc: IntegrationRow }>(`${base(orgId)}/${id}`, { ...data }),
  remove: (orgId: Id, id: Id) => api.delete<{ deleted: string }>(`${base(orgId)}/${id}`),
  rotateToken: (orgId: Id, id: Id) =>
    api.post<IntegrationSecret>(`${base(orgId)}/${id}/rotate-token`),
  events: (orgId: Id, id: Id, page = 1) =>
    api.get<IntegrationEventPage>(`${base(orgId)}/${id}/events`, { query: { page } }),
}
