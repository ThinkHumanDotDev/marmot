/**
 * Client-side calls for organizations, members, invitations and the account. Payload REST is used
 * where its access control already expresses the rule; Marmot's own route handlers under
 * `/api/orgs`, `/api/invite` and `/api/account` cover the rest.
 */
import type { Permission, Role } from '@/access/permissions'
import type { Locale } from '@/i18n/locales'
import { api } from '@/lib/api'

type Id = string | number

export interface MemberRow {
  id: Id
  email: string
  name: string | null
  avatarUrl: string | null
  role: Role
}

export interface InvitationRow {
  id: Id
  email: string
  role: Role
  expiresAt: string | null
  createdAt: string
}

export interface InviteLink {
  url: string | null
  role: Role
}

export interface SlugAvailability {
  available: boolean
  slug: string
  reason?: string
}

export type OrganizationPatch = {
  name?: string
  slug?: string
  logo?: Id | null
  settings?: { timezone?: string; weekStart?: 'monday' | 'sunday' }
}

export interface MediaDoc {
  id: Id
  url?: string | null
}

export const orgApi = {
  slugAvailable: (slug: string) =>
    api.get<SlugAvailability>('/api/orgs/slug-available', { query: { slug } }),
  create: (data: { name: string; slug: string }) =>
    api.post<{ doc: { id: Id; slug: string } }>('/api/organizations', data),
  update: (orgId: Id, data: OrganizationPatch) =>
    api.patch<{ doc: { id: Id; slug: string } }>(`/api/organizations/${orgId}`, { ...data }),
  remove: (orgId: Id) => api.delete<unknown>(`/api/organizations/${orgId}`),

  invite: (orgId: Id, data: { email: string; role: Role }) =>
    api.post<{ doc: InvitationRow }>('/api/invitations', { organization: orgId, ...data }),
  revokeInvitation: (invitationId: Id) =>
    api.patch<unknown>(`/api/invitations/${invitationId}`, { status: 'revoked' }),
  resendInvitation: (orgId: Id, invitationId: Id) =>
    api.post<{ id: Id; expiresAt: string }>(
      `/api/orgs/${orgId}/invitations/${invitationId}/resend`,
    ),

  updateMemberRole: (orgId: Id, userId: Id, role: Role) =>
    api.patch<{ member: MemberRow }>(`/api/orgs/${orgId}/members/${userId}`, { role }),
  removeMember: (orgId: Id, userId: Id) =>
    api.delete<{ removed: Id; self: boolean }>(`/api/orgs/${orgId}/members/${userId}`),
  transferOwnership: (orgId: Id, userId: Id) =>
    api.post<{ owner: Id }>(`/api/orgs/${orgId}/transfer-ownership`, { userId }),

  regenerateInviteLink: (orgId: Id, role?: Role) =>
    api.post<{ url: string; role: Role }>(`/api/orgs/${orgId}/invite-link`, role ? { role } : {}),
  disableInviteLink: (orgId: Id) =>
    api.delete<{ disabled: true }>(`/api/orgs/${orgId}/invite-link`),

  acceptInvite: (code: string) =>
    api.post<{ organization: { id: Id; slug: string; name: string }; role: Role }>(
      `/api/invite/${encodeURIComponent(code)}/accept`,
    ),
}

export type ThemePreference = 'system' | 'light' | 'dark'

export interface TwoFactorStatus {
  enabled: boolean
  verifiedAt: string | null
  backupCodesRemaining: number
}

export interface TwoFactorSetup {
  secret: string
  otpauthUrl: string
  qrDataUrl: string
}

export interface ConnectedAccount {
  id: Id
  provider: string
  providerName: string
  providerAccountId: string
  email: string | null
  lastLoginAt: string | null
}

export interface ConnectedAccounts {
  accounts: ConnectedAccount[]
  linkable: { id: string; name: string; loginPath: string }[]
  hasPassword: boolean
}

export const accountApi = {
  update: (
    userId: Id,
    data: {
      name?: string
      email?: string
      avatar?: Id | null
      theme?: ThemePreference
      language?: Locale
    },
  ) =>
    api.patch<{ doc: { id: Id; email: string; name?: string | null } }>(
      `/api/users/${userId}`,
      data,
    ),
  changePassword: (data: { currentPassword: string; password: string }) =>
    api.post<{ updated: true }>('/api/account/password', data),
  remove: (confirm: string) => api.delete<{ deleted: true }>('/api/account', { body: { confirm } }),

  /** Linked single sign-on identities (`/api/account/accounts`). */
  connectedAccounts: {
    list: () => api.get<ConnectedAccounts>('/api/account/accounts'),
    unlink: (accountId: Id) => api.delete<{ unlinked: true }>(`/api/account/accounts/${accountId}`),
  },

  /** Two-factor authentication (`/api/account/2fa/*`). */
  twoFactor: {
    status: () => api.get<TwoFactorStatus>('/api/account/2fa/backup-codes'),
    setup: (password: string) => api.post<TwoFactorSetup>('/api/account/2fa/setup', { password }),
    verify: (code: string) =>
      api.post<{ enabled: true; backupCodes: string[] }>('/api/account/2fa/verify', { code }),
    disable: (data: { password: string; code: string }) =>
      api.post<{ enabled: false }>('/api/account/2fa/disable', data),
    regenerateBackupCodes: (code: string) =>
      api.post<{ backupCodes: string[] }>('/api/account/2fa/backup-codes', { code }),
  },
}

// ---- Organization permissions ---------------------------------------------------------------

export interface PermissionsResponse {
  defaults: Record<Permission, Role>
  overrides: Partial<Record<Permission, Role>>
  effective: Record<Permission, Role>
  locked: Permission[]
  canEdit: boolean
}

export const permissionsApi = {
  get: (orgId: Id) => api.get<PermissionsResponse>(`/api/orgs/${orgId}/permissions`),
  update: (orgId: Id, overrides: Partial<Record<Permission, Role>>) =>
    api.put<PermissionsResponse>(`/api/orgs/${orgId}/permissions`, { overrides }),
}

// ---- Instance settings (superadmin) ---------------------------------------------------------

export interface InstanceSettingsInput {
  primaryBaseUrl?: string | null
  allowSignup?: boolean
  entryPage?: 'dashboard' | 'status-page'
  tlsExpiryNotifyDays?: number[]
  domainExpiryNotifyDays?: number[]
  keepDataPeriodDays?: number
  trustProxy?: boolean
  steamApiKey?: string | null
  globalpingApiToken?: string | null
}

export const instanceApi = {
  /** Payload REST global update; `instance-settings.access.update` is superadmin-only. */
  update: (data: InstanceSettingsInput) =>
    api.post<{ result: InstanceSettingsInput }>('/api/globals/instance-settings', { ...data }),
  smtpTest: (to?: string) =>
    api.post<{ sent: true; to: string }>('/api/instance/smtp-test', to ? { to } : {}),
}

/** Uploads an image to the `media` collection. */
export async function uploadMedia(file: File, alt: string): Promise<MediaDoc> {
  const form = new FormData()
  form.append('file', file)
  form.append('_payload', JSON.stringify({ alt }))
  const res = await fetch('/api/media', { method: 'POST', body: form, credentials: 'include' })
  const body = (await res.json().catch(() => null)) as {
    doc?: MediaDoc
    errors?: { message?: string }[]
  } | null
  if (!res.ok || !body?.doc) {
    throw new Error(body?.errors?.[0]?.message ?? 'Upload failed.')
  }
  return body.doc
}
