import { SSO_DOMAINS_SLUG } from '@/collections/SsoDomains'
import type { SsoDomain } from '@/payload-types'
import {
  errorMessage,
  errorStatus,
  jsonError,
  parseDocId,
  resolveOrgRequest,
  type OrgRequestContext,
} from '@/server/notifications/api'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ orgId: string; id: string }> }

/** Loads the domain as the user and only when it belongs to the organization in the URL. */
export async function loadOrgDomain(
  ctx: OrgRequestContext,
  rawId: string,
): Promise<SsoDomain | null> {
  try {
    const doc = (await ctx.payload.findByID({
      collection: SSO_DOMAINS_SLUG,
      id: parseDocId(ctx.payload, rawId),
      depth: 0,
      user: ctx.user,
      overrideAccess: false,
    })) as SsoDomain
    const owner = typeof doc.organization === 'object' ? doc.organization.id : doc.organization
    return String(owner) === String(ctx.orgId) ? doc : null
  } catch {
    return null
  }
}

/** DELETE /api/orgs/:orgId/sso/domains/:id (`sso:manage`). */
export async function DELETE(request: Request, { params }: RouteContext) {
  const { orgId, id } = await params
  const ctx = await resolveOrgRequest(request, orgId, 'sso:manage')
  if (ctx instanceof Response) return ctx

  const existing = await loadOrgDomain(ctx, id)
  if (!existing) return jsonError(404, 'Domain not found')

  try {
    await ctx.payload.delete({
      collection: SSO_DOMAINS_SLUG,
      id: existing.id,
      depth: 0,
      user: ctx.user,
      overrideAccess: false,
    })
    return Response.json({ deleted: String(existing.id) })
  } catch (error) {
    return jsonError(errorStatus(error), errorMessage(error))
  }
}
