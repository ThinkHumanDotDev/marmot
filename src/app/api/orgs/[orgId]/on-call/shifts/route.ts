import { getPayload } from 'payload'

import config from '@payload-config'
import { authenticate, authorize, parseId, payloadError } from '@/server/monitors/http'
import { listSchedules, SHIFT_HORIZON_DAYS, shiftsOf } from '@/server/on-call/store'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ orgId: string }> }

const date = (value: string | null, fallback: Date): Date => {
  const parsed = value ? new Date(value) : fallback
  return Number.isNaN(parsed.getTime()) ? fallback : parsed
}

/**
 * GET /api/orgs/:orgId/on-call/shifts — upcoming on-call shifts across the organization's
 * schedules. Query: `from`, `to` (ISO dates; default now and 28 days later, at most 92 days),
 * `user` (`me` by default, a member id, or `all`), `schedule` (one schedule id).
 */
export async function GET(request: Request, { params }: RouteContext) {
  const payload = await getPayload({ config })
  const orgId = parseId(payload, (await params).orgId)
  const auth = await authenticate(payload, request)
  if (auth.response) return auth.response
  const forbidden = await authorize(payload, auth.user, orgId, 'on-call:read')
  if (forbidden) return forbidden

  const query = new URL(request.url).searchParams
  const from = date(query.get('from'), new Date())
  const to = date(query.get('to'), new Date(from.getTime() + SHIFT_HORIZON_DAYS * 86_400_000))
  const userParam = query.get('user') ?? 'me'
  const schedule = query.get('schedule')
  try {
    const schedules = (await listSchedules(payload, orgId, auth.user)).filter(
      (doc) => !schedule || String(doc.id) === schedule,
    )
    const shifts = await shiftsOf(
      payload,
      schedules,
      from,
      to,
      userParam === 'all' ? {} : { userId: userParam === 'me' ? auth.user.id : userParam },
    )
    return Response.json({ from: from.toISOString(), to: to.toISOString(), shifts })
  } catch (error) {
    return payloadError(error, request)
  }
}
