import { getPayload } from 'payload'

import config from '@payload-config'
import { monitorFormSchema } from '@/lib/validation/monitor-schema'
import {
  authenticate,
  authorize,
  jsonError,
  parseId,
  payloadError,
  readJson,
  validationError,
} from '@/server/monitors/http'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ orgId: string }> }

/**
 * POST /api/orgs/:orgId/monitors — create a monitor in the organization.
 * Body: `MonitorFormValues` (see `src/lib/validation/monitor.ts`). Returns the created document.
 */
export async function POST(request: Request, { params }: RouteContext) {
  const payload = await getPayload({ config })
  const orgId = parseId(payload, (await params).orgId)

  const auth = await authenticate(payload, request)
  if (auth.response) return auth.response
  const forbidden = await authorize(payload, auth.user, orgId, 'monitor:create')
  if (forbidden) return forbidden

  const body = await readJson(request)
  if (!body || typeof body !== 'object') return jsonError(400, 'Expected a JSON body')
  const parsed = monitorFormSchema.safeParse(body)
  if (!parsed.success) return validationError(parsed.error)

  try {
    const doc = await payload.create({
      collection: 'monitors',
      // Relationship ids are numbers on Postgres and strings on MongoDB; the generated types follow
      // the adapter the types were generated with.
      data: { ...parsed.data, organization: orgId } as never,
      user: auth.user,
      overrideAccess: false,
      depth: 0,
    })
    return Response.json(doc, { status: 201 })
  } catch (error) {
    return payloadError(error)
  }
}
