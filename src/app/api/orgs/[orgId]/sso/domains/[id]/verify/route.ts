import { SSO_DOMAINS_SLUG } from '@/collections/SsoDomains'
import type { SsoDomain } from '@/payload-types'
import { jsonError, resolveOrgRequest } from '@/server/notifications/api'
import { toDomainRow } from '@/server/sso/domain-rows'
import { verifyDomain } from '@/server/sso/domains'

import { loadOrgDomain } from '../route'
import { errorText } from '@/server/request-locale'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ orgId: string; id: string }> }

/**
 * POST /api/orgs/:orgId/sso/domains/:id/verify — look the DNS TXT record up now (`sso:manage`).
 * Answers `{ doc, verified, reason? }`; a failed lookup is a 200 with `verified: false`.
 */
export async function POST(request: Request, { params }: RouteContext) {
  const { orgId, id } = await params
  const ctx = await resolveOrgRequest(request, orgId, 'sso:manage')
  if (ctx instanceof Response) return ctx

  const existing = await loadOrgDomain(ctx, id)
  if (!existing) return jsonError(404, errorText(request, 'domainNotFound'))
  if (existing.verifiedAt) return Response.json({ doc: toDomainRow(existing), verified: true })

  const result = await verifyDomain(ctx.payload, existing)
  const doc = (await ctx.payload.findByID({
    collection: SSO_DOMAINS_SLUG,
    id: existing.id,
    depth: 0,
    user: ctx.user,
    overrideAccess: false,
  })) as SsoDomain
  return Response.json({ doc: toDomainRow(doc), ...result })
}
