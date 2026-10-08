/** Route helpers of `/api/orgs/:orgId/locations/**`. */
import type { Location } from '@/payload-types'
import { parseDocId, type OrgRequestContext } from '@/server/notifications/api'

/** Loads the location as the user, and only when it belongs to the organization in the URL. */
export async function loadOrgLocation(
  ctx: OrgRequestContext,
  rawId: string,
): Promise<Location | null> {
  try {
    const doc = (await ctx.payload.findByID({
      collection: 'locations',
      id: parseDocId(ctx.payload, rawId),
      depth: 0,
      user: ctx.user,
      overrideAccess: false,
    })) as Location
    const owner = typeof doc.organization === 'object' ? doc.organization.id : doc.organization
    return String(owner) === String(ctx.orgId) ? doc : null
  } catch {
    return null
  }
}
