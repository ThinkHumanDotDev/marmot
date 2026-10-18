import { getPayload } from 'payload'

import config from '@payload-config'
import { isDeclaredSeverity, isDeclaredStatusFilter } from '@/lib/declared-incidents'
import { declareIncidentSchema } from '@/lib/validation/declared-incident'
import type { DeclaredIncident } from '@/payload-types'
import { declareData } from '@/server/declared-incidents/http'
import {
  listDeclaredIncidents,
  parseCommanderFilter,
  serializeDeclaredIncident,
} from '@/server/declared-incidents/store'
import {
  authenticate,
  authorize,
  parseId,
  payloadError,
  readJson,
  validationError,
} from '@/server/monitors/http'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ orgId: string }> }

/**
 * GET /api/orgs/:orgId/declared-incidents — declared incidents, newest first.
 * Query: `status` (`active` | `all` | a status, default `all`), `severity`, `commander` (a user id,
 * or `none` for unassigned incidents), `page`, `limit` (≤ 100). `stats` holds the counts and the
 * mean time to mitigate / resolve (seconds) of the severity and commander filters.
 */
export async function GET(request: Request, { params }: RouteContext) {
  const payload = await getPayload({ config })
  const orgId = parseId(payload, (await params).orgId)
  const auth = await authenticate(payload, request)
  if (auth.response) return auth.response
  const forbidden = await authorize(payload, auth.user, orgId, 'declared-incident:read')
  if (forbidden) return forbidden

  const query = new URL(request.url).searchParams
  const status = query.get('status')
  const severity = query.get('severity')
  try {
    return Response.json(
      await listDeclaredIncidents(payload, orgId, {
        status: isDeclaredStatusFilter(status) ? status : 'all',
        severity: isDeclaredSeverity(severity) ? severity : null,
        commander: parseCommanderFilter(payload, query.get('commander')),
        page: Number.parseInt(query.get('page') ?? '1', 10) || 1,
        limit: Number.parseInt(query.get('limit') ?? '25', 10) || 25,
        user: auth.user,
      }),
    )
  } catch (error) {
    return payloadError(error, request)
  }
}

/**
 * POST /api/orgs/:orgId/declared-incidents — declare an incident.
 * Body: `{ title, severity?, summary?, commander?, startedAt?, monitorIncident?, statusPageIncident? }`.
 * Answers 201 with the incident.
 */
export async function POST(request: Request, { params }: RouteContext) {
  const payload = await getPayload({ config })
  const orgId = parseId(payload, (await params).orgId)
  const auth = await authenticate(payload, request)
  if (auth.response) return auth.response
  const forbidden = await authorize(payload, auth.user, orgId, 'declared-incident:create')
  if (forbidden) return forbidden

  const parsed = declareIncidentSchema.safeParse(await readJson(request))
  if (!parsed.success) return validationError(parsed.error, request)
  try {
    const doc = (await payload.create({
      collection: 'declared-incidents',
      data: declareData(payload, orgId, parsed.data) as never,
      depth: 0,
      user: auth.user,
      overrideAccess: false,
    })) as DeclaredIncident
    return Response.json(await serializeDeclaredIncident(payload, doc), { status: 201 })
  } catch (error) {
    return payloadError(error, request)
  }
}
