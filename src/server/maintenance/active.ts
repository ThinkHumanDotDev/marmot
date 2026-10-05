import { getPayload } from 'payload'

import config from '@payload-config'
import type { Maintenance } from '@/payload-types'
import { authenticate, authorize, jsonError, parseId, payloadError } from '@/server/monitors/http'
import { loadOrgMaintenance } from './http'
import { summarizeMaintenance } from './serialize'

type RouteContext = { params: Promise<{ orgId: string; id: string }> }

/** Shared implementation of `POST .../maintenance/:id/pause` and `.../resume`. */
export function setMaintenanceActiveHandler(active: boolean) {
  return async function POST(request: Request, { params }: RouteContext) {
    const payload = await getPayload({ config })
    const { orgId: rawOrgId, id: rawId } = await params
    const orgId = parseId(payload, rawOrgId)
    const id = parseId(payload, rawId)

    const auth = await authenticate(payload, request)
    if (auth.response) return auth.response
    const forbidden = await authorize(payload, auth.user, orgId, 'maintenance:update')
    if (forbidden) return forbidden

    const existing = await loadOrgMaintenance(payload, auth.user, orgId, id)
    if (!existing) return jsonError(404, 'Maintenance not found')

    try {
      const doc = (await payload.update({
        collection: 'maintenance',
        id,
        data: { active },
        user: auth.user,
        overrideAccess: false,
        depth: 0,
      })) as Maintenance
      return Response.json(await summarizeMaintenance(payload, doc))
    } catch (error) {
      return payloadError(error)
    }
  }
}
