import { getPayload } from 'payload'

import config from '@payload-config'
import { monitorToFormValues } from '@/lib/validation/monitor'
import { monitorFormSchema } from '@/lib/validation/monitor-schema'
import {
  authenticate,
  authorize,
  jsonError,
  loadOrgMonitor,
  parseId,
  payloadError,
} from '@/server/monitors/http'
import { errorText } from '@/server/request-locale'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ orgId: string; id: string }> }

/**
 * POST /api/orgs/:orgId/monitors/:id/clone — duplicate a monitor as "<name> (copy)", paused, with
 * a fresh status cache and push token, keeping its tags and notification channels. Returns the new
 * document.
 */
export async function POST(request: Request, { params }: RouteContext) {
  const payload = await getPayload({ config })
  const { orgId: rawOrgId, id: rawId } = await params
  const orgId = parseId(payload, rawOrgId)
  const id = parseId(payload, rawId)

  const auth = await authenticate(payload, request)
  if (auth.response) return auth.response
  const forbidden = await authorize(payload, auth.user, orgId, 'monitor:create')
  if (forbidden) return forbidden

  const source = await loadOrgMonitor(payload, auth.user, orgId, id)
  if (!source) return jsonError(404, errorText(request, 'monitorNotFound'))

  const values = monitorFormSchema.parse({
    ...monitorToFormValues(source),
    name: `${source.name} (copy)`,
    active: false,
  })

  try {
    const doc = await payload.create({
      collection: 'monitors',
      data: { ...values, organization: orgId } as never,
      user: auth.user,
      overrideAccess: false,
      depth: 0,
      // The copy keeps exactly the source's channels (no default channels added).
      context: { explicitNotifications: true },
    })
    return Response.json(doc, { status: 201 })
  } catch (error) {
    return payloadError(error, request)
  }
}
