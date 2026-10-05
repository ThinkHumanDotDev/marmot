/**
 * Client-side calls for organizations, members, invitations and the account. Payload REST is used
 * where its access control already expresses the rule; Marmot's own route handlers under
 * `/api/orgs`, `/api/invite` and `/api/account` cover the rest.
 */
import type { Role } from '@/access/permissions'
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

export const accountApi = {
  update: (userId: Id, data: { name?: string; email?: string; avatar?: Id | null }) =>
    api.patch<{ doc: { id: Id; email: string; name?: string | null } }>(
      `/api/users/${userId}`,
      data,
    ),
  changePassword: (data: { currentPassword: string; password: string }) =>
    api.post<{ updated: true }>('/api/account/password', data),
  remove: (confirm: string) => api.delete<{ deleted: true }>('/api/account', { body: { confirm } }),
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
