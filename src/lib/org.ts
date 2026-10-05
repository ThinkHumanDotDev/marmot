import 'server-only'

import { getPayload } from 'payload'

import config from '@payload-config'
import { getUserRole, isSuperadmin, type Role } from '@/access/permissions'
import type { CurrentUser } from '@/lib/auth'
import type { Media, Organization } from '@/payload-types'

/** Serialisable organization slice handed from server pages to client components. */
export interface OrgSummary {
  id: string | number
  name: string
  slug: string
  logoUrl: string | null
  logoId: string | number | null
  timezone: string
  weekStart: 'monday' | 'sunday'
}

export const summarizeOrg = (org: Organization): OrgSummary => ({
  id: org.id,
  name: org.name,
  slug: org.slug,
  logoUrl: org.logo && typeof org.logo === 'object' ? ((org.logo as Media).url ?? null) : null,
  logoId: org.logo ? (typeof org.logo === 'object' ? org.logo.id : org.logo) : null,
  timezone: org.settings?.timezone || 'UTC',
  weekStart: org.settings?.weekStart ?? 'monday',
})

/**
 * Loads the organization behind a URL slug with the user's own access (`organization:read`), so
 * outsiders get `null` exactly like a missing slug. Superadmins see everything.
 */
export async function getOrgBySlug(user: CurrentUser, slug: string): Promise<Organization | null> {
  const payload = await getPayload({ config })
  const { docs } = await payload.find({
    collection: 'organizations',
    where: { slug: { equals: slug } },
    depth: 1,
    limit: 1,
    user,
    overrideAccess: false,
    disableErrors: true,
  })
  return docs[0] ?? null
}

/** The role used for permission-aware rendering; superadmins act as owners. */
export const effectiveRole = (user: CurrentUser, orgId: string | number): Role | null =>
  isSuperadmin(user) ? 'owner' : getUserRole(user, orgId)
