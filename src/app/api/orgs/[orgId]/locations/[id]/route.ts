import type { Location } from '@/payload-types'
import { toLocationRow } from '@/server/probes'
import { locationPatchSchema } from '@/server/probes/schemas'
import {
  errorMessage,
  errorStatus,
  jsonError,
  readJson,
  resolveOrgRequest,
} from '@/server/notifications/api'
import { errorText } from '@/server/request-locale'

import { loadOrgLocation } from '@/server/probes/http'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ orgId: string; id: string }> }

/** PATCH /api/orgs/:orgId/locations/:id `{ name?, slug?, labels? }` (`location:update`). */
export async function PATCH(request: Request, { params }: RouteContext) {
  const { orgId, id } = await params
  const ctx = await resolveOrgRequest(request, orgId, 'location:update')
  if (ctx instanceof Response) return ctx

  const body = await readJson(request)
  if (!body) return jsonError(400, errorText(request, 'invalidJsonBody'))
  const parsed = locationPatchSchema.safeParse(body)
  if (!parsed.success) {
    return jsonError(400, parsed.error.issues[0]?.message ?? errorText(request, 'validationFailed'))
  }
  const existing = await loadOrgLocation(ctx, id)
  if (!existing) return jsonError(404, errorText(request, 'locationNotFound'))

  try {
    const doc = (await ctx.payload.update({
      collection: 'locations',
      id: existing.id,
      data: {
        ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
        ...(parsed.data.slug !== undefined ? { slug: parsed.data.slug } : {}),
        ...(parsed.data.labels !== undefined
          ? {
              labels: parsed.data.labels.map((row) => ({
                key: row.key,
                value: row.value ?? null,
              })),
            }
          : {}),
      },
      depth: 0,
      user: ctx.user,
      overrideAccess: false,
    })) as Location
    return Response.json({ doc: toLocationRow(doc) })
  } catch (error) {
    return jsonError(errorStatus(error), errorMessage(error, request))
  }
}

/**
 * DELETE /api/orgs/:orgId/locations/:id (`location:delete`). The token stops working at once; the
 * location's monitors fall back to the local worker pool.
 */
export async function DELETE(request: Request, { params }: RouteContext) {
  const { orgId, id } = await params
  const ctx = await resolveOrgRequest(request, orgId, 'location:delete')
  if (ctx instanceof Response) return ctx

  const existing = await loadOrgLocation(ctx, id)
  if (!existing) return jsonError(404, errorText(request, 'locationNotFound'))
  try {
    await ctx.payload.delete({
      collection: 'locations',
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
