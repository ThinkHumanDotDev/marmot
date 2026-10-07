import { z } from 'zod'

import { SSO_CONNECTIONS_SLUG } from '@/collections/SsoConnections'
import { SSO_DOMAINS_SLUG } from '@/collections/SsoDomains'
import type { Organization } from '@/payload-types'
import {
  errorMessage,
  errorStatus,
  jsonError,
  readJson,
  resolveOrgRequest,
} from '@/server/notifications/api'
import { errorText } from '@/server/request-locale'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ orgId: string }> }

const schema = z.object({ enforceSso: z.boolean() })

/**
 * PATCH /api/orgs/:orgId/sso/enforcement `{ enforceSso }` (`sso:manage`, i.e. owners).
 *
 * Turning enforcement on requires at least one verified domain and one enabled connection, otherwise
 * nobody could sign in at all.
 */
export async function PATCH(request: Request, { params }: RouteContext) {
  const { orgId } = await params
  const ctx = await resolveOrgRequest(request, orgId, 'sso:manage')
  if (ctx instanceof Response) return ctx

  const parsed = schema.safeParse(await readJson(request))
  if (!parsed.success) return jsonError(400, errorText(request, 'enforceSsoRequired'))

  if (parsed.data.enforceSso) {
    const [domains, connections] = await Promise.all([
      ctx.payload.count({
        collection: SSO_DOMAINS_SLUG,
        where: { and: [{ organization: { equals: ctx.orgId } }, { verifiedAt: { exists: true } }] },
        overrideAccess: true,
      }),
      ctx.payload.count({
        collection: SSO_CONNECTIONS_SLUG,
        where: { and: [{ organization: { equals: ctx.orgId } }, { enabled: { equals: true } }] },
        overrideAccess: true,
      }),
    ])
    if (domains.totalDocs === 0 || connections.totalDocs === 0) {
      return jsonError(409, errorText(request, 'ssoEnforcementPrerequisites'))
    }
  }

  try {
    const doc = (await ctx.payload.update({
      collection: 'organizations',
      id: ctx.orgId,
      data: { enforceSso: parsed.data.enforceSso },
      depth: 0,
      user: ctx.user,
      overrideAccess: false,
    })) as Organization
    return Response.json({ enforceSso: doc.enforceSso === true })
  } catch (error) {
    return jsonError(errorStatus(error), errorMessage(error, request))
  }
}
