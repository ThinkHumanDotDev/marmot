import { getPayload } from 'payload'

import config from '@payload-config'
import {
  authenticate,
  authorize,
  jsonError,
  loadOrgMonitor,
  parseId,
  payloadError,
} from '@/server/monitors/http'

type RouteContext = { params: Promise<{ orgId: string; id: string }> }

/** Shared implementation of `POST .../monitors/:id/pause` and `.../resume`. */
export function setActiveHandler(active: boolean) {
  return async function POST(request: Request, { params }: RouteContext) {
    const payload = await getPayload({ config })
    const { orgId: rawOrgId, id: rawId } = await params
    const orgId = parseId(payload, rawOrgId)
    const id = parseId(payload, rawId)

    const auth = await authenticate(payload, request)
    if (auth.response) return auth.response
    const forbidden = await authorize(payload, auth.user, orgId, 'monitor:update')
    if (forbidden) return forbidden

    const monitor = await loadOrgMonitor(payload, auth.user, orgId, id)
    if (!monitor) return jsonError(404, 'Monitor not found')

    try {
      const doc = await payload.update({
        collection: 'monitors',
        id,
        data: { active },
        user: auth.user,
        overrideAccess: false,
        depth: 0,
      })
      return Response.json(doc)
    } catch (error) {
      return payloadError(error)
    }
  }
}
