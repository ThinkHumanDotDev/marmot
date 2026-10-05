import { getPayload, type Payload } from 'payload'

import config from '@payload-config'
import { maintenanceFormSchema, maintenanceToFormValues } from '@/lib/validation/maintenance'
import type { Maintenance } from '@/payload-types'
import {
  loadOrgMaintenance,
  PROTECTED_MAINTENANCE_FIELDS,
  summarizeMaintenance,
  toMaintenanceData,
} from '@/server/maintenance'
import {
  authenticate,
  authorize,
  jsonError,
  parseId,
  payloadError,
  readJson,
  validationError,
  type RequestUser,
  type RouteId,
} from '@/server/monitors/http'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ orgId: string; id: string }> }

type Resolved =
  | { response: Response; doc?: undefined }
  | {
      response?: undefined
      payload: Payload
      user: RequestUser
      orgId: RouteId
      id: RouteId
      doc: Maintenance
    }

/** Authenticate, check `permission` in the organization and load the maintenance (404 otherwise). */
async function resolve(
  request: Request,
  params: RouteContext['params'],
  permission: 'maintenance:read' | 'maintenance:update' | 'maintenance:delete',
): Promise<Resolved> {
  const payload = await getPayload({ config })
  const { orgId: rawOrgId, id: rawId } = await params
  const orgId = parseId(payload, rawOrgId)
  const id = parseId(payload, rawId)

  const auth = await authenticate(payload, request)
  if (auth.response) return { response: auth.response }
  const forbidden = await authorize(payload, auth.user, orgId, permission)
  if (forbidden) return { response: forbidden }

  const doc = await loadOrgMaintenance(payload, auth.user, orgId, id)
  if (!doc) return { response: jsonError(404, 'Maintenance not found') }
  return { payload, user: auth.user, orgId, id, doc }
}

/** GET /api/orgs/:orgId/maintenance/:id — one maintenance as `MaintenanceSummary`. */
export async function GET(request: Request, { params }: RouteContext): Promise<Response> {
  const ctx = await resolve(request, params, 'maintenance:read')
  if (ctx.response) return ctx.response
  return Response.json(await summarizeMaintenance(ctx.payload, ctx.doc))
}

/**
 * PATCH /api/orgs/:orgId/maintenance/:id — update. Accepts a partial body: it is merged over the
 * stored document and the result is validated as a whole, so strategy requirements hold.
 */
export async function PATCH(request: Request, { params }: RouteContext): Promise<Response> {
  const ctx = await resolve(request, params, 'maintenance:update')
  if (ctx.response) return ctx.response

  const body = await readJson(request)
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return jsonError(400, 'Expected a JSON body')
  }
  const patch = { ...(body as Record<string, unknown>) }
  for (const key of PROTECTED_MAINTENANCE_FIELDS) delete patch[key]

  const parsed = maintenanceFormSchema.safeParse({ ...maintenanceToFormValues(ctx.doc), ...patch })
  if (!parsed.success) return validationError(parsed.error)

  try {
    const doc = (await ctx.payload.update({
      collection: 'maintenance',
      id: ctx.id,
      data: toMaintenanceData(ctx.payload, parsed.data) as never,
      user: ctx.user,
      overrideAccess: false,
      depth: 0,
    })) as Maintenance
    return Response.json(await summarizeMaintenance(ctx.payload, doc))
  } catch (error) {
    return payloadError(error)
  }
}

/** DELETE /api/orgs/:orgId/maintenance/:id */
export async function DELETE(request: Request, { params }: RouteContext): Promise<Response> {
  const ctx = await resolve(request, params, 'maintenance:delete')
  if (ctx.response) return ctx.response

  try {
    await ctx.payload.delete({
      collection: 'maintenance',
      id: ctx.id,
      user: ctx.user,
      overrideAccess: false,
      depth: 0,
    })
    return Response.json({ id: String(ctx.id), deleted: true })
  } catch (error) {
    return payloadError(error)
  }
}
