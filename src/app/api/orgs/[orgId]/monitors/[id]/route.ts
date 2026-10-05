import { getPayload } from 'payload'

import config from '@payload-config'
import { monitorFormSchema, monitorToFormValues } from '@/lib/validation/monitor'
import {
  authenticate,
  authorize,
  jsonError,
  loadOrgMonitor,
  parseId,
  payloadError,
  PROTECTED_MONITOR_FIELDS,
  readJson,
  validationError,
} from '@/server/monitors/http'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ orgId: string; id: string }> }

/**
 * PATCH /api/orgs/:orgId/monitors/:id — update a monitor. Accepts a partial body: it is merged
 * over the stored document and the result is validated as a whole, so type requirements hold.
 */
export async function PATCH(request: Request, { params }: RouteContext) {
  const payload = await getPayload({ config })
  const { orgId: rawOrgId, id: rawId } = await params
  const orgId = parseId(payload, rawOrgId)
  const id = parseId(payload, rawId)

  const auth = await authenticate(payload, request)
  if (auth.response) return auth.response
  const forbidden = authorize(auth.user, orgId, 'monitor:update')
  if (forbidden) return forbidden

  const monitor = await loadOrgMonitor(payload, auth.user, orgId, id)
  if (!monitor) return jsonError(404, 'Monitor not found')

  const body = await readJson(request)
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return jsonError(400, 'Expected a JSON body')
  }
  const patch = { ...(body as Record<string, unknown>) }
  for (const key of PROTECTED_MONITOR_FIELDS) delete patch[key]

  const parsed = monitorFormSchema.safeParse({ ...monitorToFormValues(monitor), ...patch })
  if (!parsed.success) return validationError(parsed.error)

  try {
    const doc = await payload.update({
      collection: 'monitors',
      id,
      data: parsed.data as never,
      user: auth.user,
      overrideAccess: false,
      depth: 0,
    })
    return Response.json(doc)
  } catch (error) {
    return payloadError(error)
  }
}

/** DELETE /api/orgs/:orgId/monitors/:id — delete a monitor (heartbeats and stats go with it). */
export async function DELETE(request: Request, { params }: RouteContext) {
  const payload = await getPayload({ config })
  const { orgId: rawOrgId, id: rawId } = await params
  const orgId = parseId(payload, rawOrgId)
  const id = parseId(payload, rawId)

  const auth = await authenticate(payload, request)
  if (auth.response) return auth.response
  const forbidden = authorize(auth.user, orgId, 'monitor:delete')
  if (forbidden) return forbidden

  const monitor = await loadOrgMonitor(payload, auth.user, orgId, id)
  if (!monitor) return jsonError(404, 'Monitor not found')

  try {
    const doc = await payload.delete({
      collection: 'monitors',
      id,
      user: auth.user,
      overrideAccess: false,
      depth: 0,
    })
    return Response.json(doc)
  } catch (error) {
    return payloadError(error)
  }
}
