import { getPayload, type Where } from 'payload'

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
import { errorText } from '@/server/request-locale'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ orgId: string }> }

const MAX_LIMIT = 500

/** Positive integer query parameter, clamped to `max`; `fallback` when missing or invalid. */
function intParam(url: URL, name: string, fallback: number, max: number): number {
  const value = Number(url.searchParams.get(name))
  return Number.isInteger(value) && value > 0 ? Math.min(value, max) : fallback
}

/**
 * GET /api/orgs/:orgId/monitors — the organization's monitors (`monitor:read`), sorted by name.
 * Query: `limit` (1–500, default 100), `page` (default 1), `type`, `active` (`true`/`false`),
 * `key` (the monitors-as-code key).
 * Answers Payload's pagination envelope (`docs`, `totalDocs`, `page`, `totalPages`, …).
 */
export async function GET(request: Request, { params }: RouteContext) {
  const payload = await getPayload({ config })
  const orgId = parseId(payload, (await params).orgId)

  const auth = await authenticate(payload, request)
  if (auth.response) return auth.response
  const forbidden = await authorize(payload, auth.user, orgId, 'monitor:read')
  if (forbidden) return forbidden

  const url = new URL(request.url)
  const and: Where[] = [{ organization: { equals: orgId } }]
  const type = url.searchParams.get('type')
  if (type) and.push({ type: { equals: type } })
  const key = url.searchParams.get('key')
  if (key) and.push({ key: { equals: key } })
  const active = url.searchParams.get('active')
  if (active === 'true' || active === 'false') and.push({ active: { equals: active === 'true' } })

  try {
    const result = await payload.find({
      collection: 'monitors',
      where: { and },
      sort: 'name',
      limit: intParam(url, 'limit', 100, MAX_LIMIT),
      page: intParam(url, 'page', 1, Number.MAX_SAFE_INTEGER),
      depth: 0,
      user: auth.user,
      overrideAccess: false,
    })
    return Response.json(result)
  } catch (error) {
    return payloadError(error, request)
  }
}

/**
 * POST /api/orgs/:orgId/monitors — create a monitor in the organization.
 * Body: `MonitorFormValues` (see `src/lib/validation/monitor.ts`). Returns the created document.
 * `notifications` lists the channels to attach; when the key is missing the organization's default
 * channels are attached instead.
 */
export async function POST(request: Request, { params }: RouteContext) {
  const payload = await getPayload({ config })
  const orgId = parseId(payload, (await params).orgId)

  const auth = await authenticate(payload, request)
  if (auth.response) return auth.response
  const forbidden = await authorize(payload, auth.user, orgId, 'monitor:create')
  if (forbidden) return forbidden

  const body = await readJson(request)
  if (!body || typeof body !== 'object')
    return jsonError(400, errorText(request, 'expectedJsonBody'))
  const parsed = monitorFormSchema.safeParse(body)
  if (!parsed.success) return validationError(parsed.error, request)

  try {
    const doc = await payload.create({
      collection: 'monitors',
      // Relationship ids are numbers on Postgres and strings on MongoDB; the generated types follow
      // the adapter the types were generated with.
      data: { ...parsed.data, organization: orgId } as never,
      user: auth.user,
      overrideAccess: false,
      depth: 0,
      // A body that lists `notifications` (the form always does) is a deliberate selection, even
      // when empty; without the key the organization's default channels are attached.
      context: {
        explicitNotifications: Array.isArray((body as { notifications?: unknown }).notifications),
      },
    })
    return Response.json(doc, { status: 201 })
  } catch (error) {
    return payloadError(error, request)
  }
}
