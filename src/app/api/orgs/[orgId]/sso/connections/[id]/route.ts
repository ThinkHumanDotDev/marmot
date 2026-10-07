import { SSO_CONNECTIONS_SLUG } from '@/collections/SsoConnections'
import type { SsoConnection } from '@/payload-types'
import {
  errorMessage,
  errorStatus,
  jsonError,
  parseDocId,
  readJson,
  resolveOrgRequest,
  type OrgRequestContext,
} from '@/server/notifications/api'
import { toConnectionRow } from '@/server/sso/connections'

import { connectionSchema, reloadConnection } from '../route'
import { errorText } from '@/server/request-locale'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ orgId: string; id: string }> }

/** Loads the connection as the user and only when it belongs to the organization in the URL. */
export async function loadOrgConnection(
  ctx: OrgRequestContext,
  rawId: string,
): Promise<SsoConnection | null> {
  try {
    const doc = (await ctx.payload.findByID({
      collection: SSO_CONNECTIONS_SLUG,
      id: parseDocId(ctx.payload, rawId),
      depth: 0,
      user: ctx.user,
      overrideAccess: false,
    })) as SsoConnection
    const owner = typeof doc.organization === 'object' ? doc.organization.id : doc.organization
    return String(owner) === String(ctx.orgId) ? doc : null
  } catch {
    return null
  }
}

/**
 * PATCH /api/orgs/:orgId/sso/connections/:id — update any field (`sso:manage`). An empty or
 * missing `clientSecret` keeps the stored secret.
 */
export async function PATCH(request: Request, { params }: RouteContext) {
  const { orgId, id } = await params
  const ctx = await resolveOrgRequest(request, orgId, 'sso:manage')
  if (ctx instanceof Response) return ctx

  const body = await readJson(request)
  if (!body) return jsonError(400, errorText(request, 'invalidJsonBody'))
  const parsed = connectionSchema.partial().safeParse(body)
  if (!parsed.success) {
    return jsonError(400, parsed.error.issues[0]?.message ?? errorText(request, 'validationFailed'))
  }
  const data = { ...parsed.data }
  if (!data.clientSecret) delete data.clientSecret

  const existing = await loadOrgConnection(ctx, id)
  if (!existing) return jsonError(404, errorText(request, 'connectionNotFound'))

  try {
    await ctx.payload.update({
      collection: SSO_CONNECTIONS_SLUG,
      id: existing.id,
      data: data as never,
      depth: 0,
      user: ctx.user,
      overrideAccess: false,
    })
    return Response.json({ doc: toConnectionRow(await reloadConnection(ctx.payload, existing.id)) })
  } catch (error) {
    return jsonError(errorStatus(error), errorMessage(error, request))
  }
}

/** DELETE /api/orgs/:orgId/sso/connections/:id (`sso:manage`). */
export async function DELETE(request: Request, { params }: RouteContext) {
  const { orgId, id } = await params
  const ctx = await resolveOrgRequest(request, orgId, 'sso:manage')
  if (ctx instanceof Response) return ctx

  const existing = await loadOrgConnection(ctx, id)
  if (!existing) return jsonError(404, errorText(request, 'connectionNotFound'))

  try {
    await ctx.payload.delete({
      collection: SSO_CONNECTIONS_SLUG,
      id: existing.id,
      depth: 0,
      user: ctx.user,
      overrideAccess: false,
    })
    return Response.json({ deleted: String(existing.id) })
  } catch (error) {
    return jsonError(errorStatus(error), errorMessage(error, request))
  }
}
