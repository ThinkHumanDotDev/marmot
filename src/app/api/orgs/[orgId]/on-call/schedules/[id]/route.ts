import { getPayload } from 'payload'

import config from '@payload-config'
import { updateScheduleSchema } from '@/lib/validation/on-call'
import type { OnCallSchedule } from '@/payload-types'
import {
  authenticate,
  authorize,
  jsonError,
  parseId,
  payloadError,
  readJson,
  validationError,
} from '@/server/monitors/http'
import { scheduleData } from '@/server/on-call/http'
import { loadOrgSchedule, serializeSchedules } from '@/server/on-call/store'
import { errorText } from '@/server/request-locale'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ orgId: string; id: string }> }

/** GET /api/orgs/:orgId/on-call/schedules/:id — one schedule with who is on call now. */
export async function GET(request: Request, { params }: RouteContext) {
  const payload = await getPayload({ config })
  const { orgId: rawOrgId, id } = await params
  const orgId = parseId(payload, rawOrgId)
  const auth = await authenticate(payload, request)
  if (auth.response) return auth.response
  const forbidden = await authorize(payload, auth.user, orgId, 'on-call:read')
  if (forbidden) return forbidden

  const doc = await loadOrgSchedule(payload, auth.user, orgId, parseId(payload, id))
  if (!doc) return jsonError(404, errorText(request, 'onCallNotFound'))
  const [summary] = await serializeSchedules(payload, [doc])
  return Response.json(summary)
}

/**
 * PATCH /api/orgs/:orgId/on-call/schedules/:id — change `name`, `description`, `timezone`,
 * `layers` or `overrides` (each list replaces the stored one).
 */
export async function PATCH(request: Request, { params }: RouteContext) {
  const payload = await getPayload({ config })
  const { orgId: rawOrgId, id } = await params
  const orgId = parseId(payload, rawOrgId)
  const auth = await authenticate(payload, request)
  if (auth.response) return auth.response
  const forbidden = await authorize(payload, auth.user, orgId, 'on-call:manage')
  if (forbidden) return forbidden

  const parsed = updateScheduleSchema.safeParse(await readJson(request))
  if (!parsed.success) return validationError(parsed.error, request)
  const existing = await loadOrgSchedule(payload, auth.user, orgId, parseId(payload, id))
  if (!existing) return jsonError(404, errorText(request, 'onCallNotFound'))
  try {
    const doc = (await payload.update({
      collection: 'on-call-schedules',
      id: existing.id,
      data: scheduleData(payload, parsed.data) as never,
      depth: 0,
      user: auth.user,
      overrideAccess: false,
    })) as OnCallSchedule
    const [summary] = await serializeSchedules(payload, [doc])
    return Response.json(summary)
  } catch (error) {
    return payloadError(error, request)
  }
}

/** DELETE /api/orgs/:orgId/on-call/schedules/:id */
export async function DELETE(request: Request, { params }: RouteContext) {
  const payload = await getPayload({ config })
  const { orgId: rawOrgId, id } = await params
  const orgId = parseId(payload, rawOrgId)
  const auth = await authenticate(payload, request)
  if (auth.response) return auth.response
  const forbidden = await authorize(payload, auth.user, orgId, 'on-call:manage')
  if (forbidden) return forbidden

  const existing = await loadOrgSchedule(payload, auth.user, orgId, parseId(payload, id))
  if (!existing) return jsonError(404, errorText(request, 'onCallNotFound'))
  try {
    await payload.delete({
      collection: 'on-call-schedules',
      id: existing.id,
      user: auth.user,
      overrideAccess: false,
    })
    return new Response(null, { status: 204 })
  } catch (error) {
    return payloadError(error, request)
  }
}
