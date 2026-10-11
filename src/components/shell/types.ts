import type { OrgMembership } from '@/lib/auth'

/** Serialisable slice of the current user handed from server layouts to client shell parts. */
export interface ShellUser {
  id: string | number
  email: string
  name?: string | null
  superadmin?: boolean
  /** `users.authProvider`; SSO accounts sign out through the identity provider too. */
  authProvider?: 'local' | 'oidc' | 'oauth' | 'saml' | 'magic-link' | null
  /** `users.theme`, saved when changed from the user menu. */
  theme?: 'system' | 'light' | 'dark' | null
}

export interface ShellContext {
  user: ShellUser
  organizations: OrgMembership[]
  currentOrg: OrgMembership
}
