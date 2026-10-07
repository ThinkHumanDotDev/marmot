/** Client-side calls for probe locations (`/api/orgs/:orgId/locations`). */
import { api } from '@/lib/api'
import type { LocationRow } from '@/server/probes'

export type { LocationRow }

type Id = string | number

export interface LocationInput {
  name: string
  slug?: string
  labels?: { key: string; value: string | null }[]
}

export const locationsApi = {
  list: (orgId: Id) => api.get<{ docs: LocationRow[] }>(`/api/orgs/${orgId}/locations`),
  /** The plaintext `token` is only returned by this call and by `rotateToken`. */
  create: (orgId: Id, data: LocationInput) =>
    api.post<{ doc: LocationRow; token: string }>(`/api/orgs/${orgId}/locations`, { ...data }),
  update: (orgId: Id, id: Id, data: Partial<LocationInput>) =>
    api.patch<{ doc: LocationRow }>(`/api/orgs/${orgId}/locations/${id}`, { ...data }),
  rotateToken: (orgId: Id, id: Id) =>
    api.post<{ doc: LocationRow; token: string }>(
      `/api/orgs/${orgId}/locations/${id}/rotate-token`,
      {},
    ),
  remove: (orgId: Id, id: Id) =>
    api.delete<{ deleted: string }>(`/api/orgs/${orgId}/locations/${id}`),
}
