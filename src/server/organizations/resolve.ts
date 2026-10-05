import type { Payload } from 'payload'

import type { Organization, User } from '@/payload-types'

/**
 * Finds an organization by URL slug as the request user (`overrideAccess: false`), so a member of
 * another organization gets `null` while superadmins see everything.
 */
export async function findOrganizationBySlug(
  payload: Payload,
  user: User,
  slug: string,
): Promise<Organization | null> {
  const { docs } = await payload.find({
    collection: 'organizations',
    where: { slug: { equals: slug.toLowerCase() } },
    limit: 1,
    depth: 0,
    user: { ...user, collection: 'users' },
    overrideAccess: false,
    disableErrors: true,
  })
  return docs[0] ?? null
}
