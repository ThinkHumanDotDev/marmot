/** Client-side calls for the billing settings page (`/api/orgs/:orgId/billing/**`). */
import { api } from '@/lib/api'
import type { Plan } from '@/lib/entitlements'
import type { BillingOverview } from '@/server/billing/overview'

type Id = string | number

export type { BillingOverview }

export const billingApi = {
  overview: (orgId: Id) => api.get<BillingOverview>(`/api/orgs/${orgId}/billing`),
  checkout: (orgId: Id, plan: Plan, interval?: 'month' | 'year') =>
    api.post<{ url: string }>(`/api/orgs/${orgId}/billing/checkout`, { plan, interval }),
  portal: (orgId: Id) => api.post<{ url: string }>(`/api/orgs/${orgId}/billing/portal`),
}
