import 'server-only'

import { notFound } from 'next/navigation'
import { getPayload, type Payload } from 'payload'

import config from '@payload-config'
import { can, type Permission } from '@/access/permissions'
import { getUserOrganizations, requireUser, type CurrentUser, type OrgMembership } from '@/lib/auth'

export interface OrgContext {
  payload: Payload
  user: CurrentUser
  org: OrgMembership
  can: (permission: Permission) => boolean
}

/**
 * Resolves the organization behind `/[orgSlug]/status-pages/**` for the signed-in user. Members
 * get their membership row; superadmins may open any organization by slug. Unknown slugs 404
 * (the layout already redirected non-members elsewhere).
 */
export async function resolveOrg(orgSlug: string): Promise<OrgContext> {
  const user = await requireUser(`/${orgSlug}/status-pages`)
  const payload = await getPayload({ config })
  const memberships = await getUserOrganizations(user, payload)
  let org = memberships.find((m) => m.slug === orgSlug)

  if (!org && user.superadmin) {
    const { docs } = await payload.find({
      collection: 'organizations',
      where: { slug: { equals: orgSlug } },
      limit: 1,
      depth: 0,
      overrideAccess: true,
    })
    const doc = docs[0]
    if (doc) org = { id: doc.id, slug: doc.slug, name: doc.name, role: 'superadmin' }
  }

  if (!org) notFound()
  const resolved = org

  return {
    payload,
    user,
    org: resolved,
    can: (permission) => can(user, resolved.id, permission),
  }
}
