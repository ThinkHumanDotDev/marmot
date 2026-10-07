import { z } from 'zod'

import type { ApiKey } from '@/payload-types'
import { toApiKeyRow } from '@/server/api-keys'
import {
  errorMessage,
  errorStatus,
  jsonError,
  parseDocId,
  readJson,
  resolveOrgRequest,
  type OrgRequestContext,
} from '@/server/notifications/api'
import { errorText } from '@/server/request-locale'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ orgId: string; id: string }> }

const patchSchema = z.object({ active: z.boolean() })

/** Loads the key as the user and only when it belongs to the organization in the URL. */
async function loadOrgApiKey(ctx: OrgRequestContext, rawId: string): Promise<ApiKey | null> {
  try {
    const doc = (await ctx.payload.findByID({
      collection: 'api-keys',
      id: parseDocId(ctx.payload, rawId),
      depth: 0,
      user: ctx.user,
      overrideAccess: false,
    })) as ApiKey
    const owner = typeof doc.organization === 'object' ? doc.organization.id : doc.organization
    return String(owner) === String(ctx.orgId) ? doc : null
  } catch {
    return null
  }
}

/** PATCH /api/orgs/:orgId/api-keys/:id `{ active }` — disable or re-enable (`api-key:delete`). */
export async function PATCH(request: Request, { params }: RouteContext) {
  const { orgId, id } = await params
  const ctx = await resolveOrgRequest(request, orgId, 'api-key:delete')
  if (ctx instanceof Response) return ctx

  const body = await readJson(request)
  const parsed = patchSchema.safeParse(body)
  if (!parsed.success) return jsonError(400, errorText(request, 'activeRequired'))

  const existing = await loadOrgApiKey(ctx, id)
  if (!existing) return jsonError(404, errorText(request, 'apiKeyNotFound'))

  try {
    const doc = (await ctx.payload.update({
      collection: 'api-keys',
      id: existing.id,
      data: { active: parsed.data.active },
      depth: 0,
      user: ctx.user,
      overrideAccess: false,
    })) as ApiKey
    return Response.json({ doc: toApiKeyRow(doc) })
  } catch (error) {
    return jsonError(errorStatus(error), errorMessage(error, request))
  }
}

/** DELETE /api/orgs/:orgId/api-keys/:id — revoke permanently (`api-key:delete`). */
export async function DELETE(request: Request, { params }: RouteContext) {
  const { orgId, id } = await params
  const ctx = await resolveOrgRequest(request, orgId, 'api-key:delete')
  if (ctx instanceof Response) return ctx

  const existing = await loadOrgApiKey(ctx, id)
  if (!existing) return jsonError(404, errorText(request, 'apiKeyNotFound'))

  try {
    await ctx.payload.delete({
      collection: 'api-keys',
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
