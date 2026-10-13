import { getPayload } from 'payload'

import config from '@payload-config'
import { authenticate, authorize, parseId, payloadError } from '@/server/monitors/http'
import { listSchedules, serializeSchedules } from '@/server/on-call/store'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ orgId: string }> }

/**
 * GET /api/orgs/:orgId/on-call — who is on call in every schedule of the organization, now or at
 * `?at=<ISO date>`, with the end of their current shift.
 */
export async function GET(request: Request, { params }: RouteContext) {
  const payload = await getPayload({ config })
  const orgId = parseId(payload, (await params).orgId)
  const auth = await authenticate(payload, request)
  if (auth.response) return auth.response
  const forbidden = await authorize(payload, auth.user, orgId, 'on-call:read')
  if (forbidden) return forbidden

  const raw = new URL(request.url).searchParams.get('at')
  const parsed = raw ? new Date(raw) : new Date()
  const at = Number.isNaN(parsed.getTime()) ? new Date() : parsed
  try {
    const schedules = await listSchedules(payload, orgId, auth.user)
    return Response.json({
      at: at.toISOString(),
      schedules: await serializeSchedules(payload, schedules, at),
    })
  } catch (error) {
    return payloadError(error, request)
  }
}
