import { getPayload } from 'payload'

import config from '@payload-config'
import { maintenanceFormSchema } from '@/lib/validation/maintenance'
import { unfilledPlaceholders } from '@/lib/templates'
import type { Maintenance } from '@/payload-types'
import { listOrgMaintenance, summarizeMaintenance, toMaintenanceData } from '@/server/maintenance'
import {
  authenticate,
  authorize,
  jsonError,
  parseId,
  payloadError,
  readJson,
  validationError,
} from '@/server/monitors/http'
import { errorText, requestLocale } from '@/server/request-locale'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ orgId: string }> }

/**
 * GET /api/orgs/:orgId/maintenance — every maintenance of the organization as
 * `MaintenanceSummary` (status and windows computed for now), running ones first.
 */
export async function GET(request: Request, { params }: RouteContext) {
  const payload = await getPayload({ config })
  const orgId = parseId(payload, (await params).orgId)

  const auth = await authenticate(payload, request)
  if (auth.response) return auth.response
  const forbidden = await authorize(payload, auth.user, orgId, 'maintenance:read')
  if (forbidden) return forbidden

  try {
    const docs = await listOrgMaintenance(payload, orgId, {
      user: auth.user,
      overrideAccess: false,
      locale: requestLocale(request),
    })
    return Response.json({ docs })
  } catch (error) {
    return payloadError(error, request)
  }
}

/**
 * POST /api/orgs/:orgId/maintenance — schedule a maintenance.
 * Body: `MaintenanceFormValues` (see `src/lib/validation/maintenance.ts`). Returns the summary.
 */
export async function POST(request: Request, { params }: RouteContext) {
  const payload = await getPayload({ config })
  const orgId = parseId(payload, (await params).orgId)

  const auth = await authenticate(payload, request)
  if (auth.response) return auth.response
  const forbidden = await authorize(payload, auth.user, orgId, 'maintenance:create')
  if (forbidden) return forbidden

  const body = await readJson(request)
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return jsonError(400, errorText(request, 'expectedJsonBody'))
  }
  const parsed = maintenanceFormSchema.safeParse(body)
  if (!parsed.success) return validationError(parsed.error, request)
  const unfilled = unfilledPlaceholders(parsed.data.title, parsed.data.description)
  if (unfilled) return jsonError(400, errorText(request, 'templatePlaceholdersUnfilled', unfilled))

  try {
    const doc = (await payload.create({
      collection: 'maintenance',
      // Relationship ids are numbers on Postgres and strings on MongoDB; the generated types
      // follow the adapter the types were generated with.
      data: { ...toMaintenanceData(payload, parsed.data), organization: orgId } as never,
      user: auth.user,
      overrideAccess: false,
      depth: 0,
    })) as Maintenance
    return Response.json(await summarizeMaintenance(payload, doc), { status: 201 })
  } catch (error) {
    return payloadError(error, request)
  }
}
