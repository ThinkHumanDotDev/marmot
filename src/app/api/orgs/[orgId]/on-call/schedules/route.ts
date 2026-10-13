import { getPayload } from 'payload'

import config from '@payload-config'
import { scheduleSchema } from '@/lib/validation/on-call'
import type { OnCallSchedule } from '@/payload-types'
import {
  authenticate,
  authorize,
  parseId,
  payloadError,
  readJson,
  validationError,
} from '@/server/monitors/http'
import { scheduleData } from '@/server/on-call/http'
import { listSchedules, serializeSchedules } from '@/server/on-call/store'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ orgId: string }> }

/** GET /api/orgs/:orgId/on-call/schedules — the organization's on-call schedules, by name. */
export async function GET(request: Request, { params }: RouteContext) {
  const payload = await getPayload({ config })
  const orgId = parseId(payload, (await params).orgId)
  const auth = await authenticate(payload, request)
  if (auth.response) return auth.response
  const forbidden = await authorize(payload, auth.user, orgId, 'on-call:read')
  if (forbidden) return forbidden
  try {
    const docs = await listSchedules(payload, orgId, auth.user)
    return Response.json({ docs: await serializeSchedules(payload, docs) })
  } catch (error) {
    return payloadError(error, request)
  }
}

/**
 * POST /api/orgs/:orgId/on-call/schedules — create a schedule. Body: `{ name, description?,
 * timezone, layers: [{ rotation, handoffTime, startDate, members, … }], overrides? }`.
 */
export async function POST(request: Request, { params }: RouteContext) {
  const payload = await getPayload({ config })
  const orgId = parseId(payload, (await params).orgId)
  const auth = await authenticate(payload, request)
  if (auth.response) return auth.response
  const forbidden = await authorize(payload, auth.user, orgId, 'on-call:manage')
  if (forbidden) return forbidden

  const parsed = scheduleSchema.safeParse(await readJson(request))
  if (!parsed.success) return validationError(parsed.error, request)
  try {
    const doc = (await payload.create({
      collection: 'on-call-schedules',
      data: scheduleData(payload, parsed.data, orgId) as never,
      depth: 0,
      user: auth.user,
      overrideAccess: false,
    })) as OnCallSchedule
    const [summary] = await serializeSchedules(payload, [doc])
    return Response.json(summary, { status: 201 })
  } catch (error) {
    return payloadError(error, request)
  }
}
