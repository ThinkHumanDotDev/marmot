/** Client-side calls for organization API keys (`/api/orgs/:orgId/api-keys`). */
import { api } from '@/lib/api'
import type { ApiKeyScope } from '@/lib/api-key-scopes'
import type { ApiKeyRow } from '@/server/api-keys'

export type { ApiKeyRow }

type Id = string | number

export interface CreateApiKeyInput {
  name: string
  /** `read` (default) or `write`; fixed once the key exists. */
  scope?: ApiKeyScope
  /** Days until expiry; omit or `null` for a key that never expires. */
  expiresInDays?: number | null
}

export const apiKeysApi = {
  list: (orgId: Id) => api.get<{ docs: ApiKeyRow[] }>(`/api/orgs/${orgId}/api-keys`),
  /** The plaintext `key` is only ever returned by this call. */
  create: (orgId: Id, data: CreateApiKeyInput) =>
    api.post<{ doc: ApiKeyRow; key: string }>(`/api/orgs/${orgId}/api-keys`, { ...data }),
  setActive: (orgId: Id, id: Id, active: boolean) =>
    api.patch<{ doc: ApiKeyRow }>(`/api/orgs/${orgId}/api-keys/${id}`, { active }),
  revoke: (orgId: Id, id: Id) =>
    api.delete<{ deleted: string }>(`/api/orgs/${orgId}/api-keys/${id}`),
}
