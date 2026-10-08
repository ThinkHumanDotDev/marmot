import type { Location } from '@/payload-types'
import { AUDIT_VERB_CONTEXT } from '@/server/audit/context'
import { toLocationRow } from '@/server/probes'
import { generateProbeToken } from '@/server/probes/tokens'
import { errorMessage, errorStatus, jsonError, resolveOrgRequest } from '@/server/notifications/api'
import { errorText } from '@/server/request-locale'

import { loadOrgLocation } from '@/server/probes/http'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ orgId: string; id: string }> }

/**
 * POST /api/orgs/:orgId/locations/:id/rotate-token (`location:update`) — mint a new token. The old
 * one stops working at once; the response carries the new plaintext `token` exactly once.
 */
export async function POST(request: Request, { params }: RouteContext) {
  const { orgId, id } = await params
  const ctx = await resolveOrgRequest(request, orgId, 'location:update')
  if (ctx instanceof Response) return ctx

  const existing = await loadOrgLocation(ctx, id)
  if (!existing) return jsonError(404, errorText(request, 'locationNotFound'))

  const generated = generateProbeToken()
  try {
    // Server-only fields: access was checked above, so field access is bypassed on purpose.
    const doc = (await ctx.payload.update({
      collection: 'locations',
      id: existing.id,
      data: {
        tokenHash: generated.tokenHash,
        tokenPrefix: generated.prefix,
        tokenRotatedAt: new Date().toISOString(),
      },
      depth: 0,
      user: ctx.user,
      overrideAccess: true,
      context: { [AUDIT_VERB_CONTEXT]: { location: 'location.token_rotated' } },
    })) as Location
    return Response.json({ doc: toLocationRow(doc), token: generated.token })
  } catch (error) {
    return jsonError(errorStatus(error), errorMessage(error, request))
  }
}
