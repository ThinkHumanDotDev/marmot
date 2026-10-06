/** Client-side calls for organization single sign-on (`/api/orgs/:orgId/sso/*`, `/api/auth/sso/lookup`). */
import { api } from '@/lib/api'
import type { SsoDomainRow } from '@/server/sso/domain-rows'
import type { SsoConnectionRow } from '@/server/sso/connections'
import type { SsoLoginOption } from '@/server/sso/domains'

export type { SsoConnectionRow, SsoDomainRow, SsoLoginOption }

type Id = string | number

export interface SsoConnectionInput {
  name: string
  slug: string
  type: 'oidc' | 'saml'
  enabled?: boolean
  issuerUrl?: string
  clientId?: string
  /** Omit or leave empty on update to keep the stored secret. */
  clientSecret?: string
  scopes?: string
  idpEntryPoint?: string
  idpEntityId?: string
  idpCert?: string
  wantAssertionsSigned?: boolean
  allowIdpInitiated?: boolean
  autoProvision?: boolean
  defaultRole?: 'admin' | 'member' | 'viewer'
}

export interface ParsedIdpMetadata {
  entityId: string
  entryPoint: string
  binding: 'redirect' | 'post'
  certificate: string | null
  certificates: string[]
  logoutUrl: string | null
  nameIdFormats: string[]
}

export const ssoApi = {
  connections: {
    list: (orgId: Id) =>
      api.get<{ docs: SsoConnectionRow[] }>(`/api/orgs/${orgId}/sso/connections`),
    create: (orgId: Id, data: SsoConnectionInput) =>
      api.post<{ doc: SsoConnectionRow }>(`/api/orgs/${orgId}/sso/connections`, { ...data }),
    update: (orgId: Id, id: Id, data: Partial<SsoConnectionInput>) =>
      api.patch<{ doc: SsoConnectionRow }>(`/api/orgs/${orgId}/sso/connections/${id}`, { ...data }),
    remove: (orgId: Id, id: Id) =>
      api.delete<{ deleted: string }>(`/api/orgs/${orgId}/sso/connections/${id}`),
  },
  domains: {
    list: (orgId: Id) => api.get<{ docs: SsoDomainRow[] }>(`/api/orgs/${orgId}/sso/domains`),
    add: (orgId: Id, domain: string) =>
      api.post<{ doc: SsoDomainRow }>(`/api/orgs/${orgId}/sso/domains`, { domain }),
    verify: (orgId: Id, id: Id) =>
      api.post<{ doc: SsoDomainRow; verified: boolean; reason?: string }>(
        `/api/orgs/${orgId}/sso/domains/${id}/verify`,
      ),
    remove: (orgId: Id, id: Id) =>
      api.delete<{ deleted: string }>(`/api/orgs/${orgId}/sso/domains/${id}`),
  },
  parseMetadata: (orgId: Id, input: { url: string } | { xml: string }) =>
    api.post<ParsedIdpMetadata>(`/api/orgs/${orgId}/sso/metadata`, { ...input }),
  /** Public: where to send someone who wants to sign in with their organization's SSO. */
  lookup: (input: { email: string } | { organization: string }) =>
    api.post<{ options: SsoLoginOption[] }>('/api/auth/sso/lookup', { ...input }),
}
