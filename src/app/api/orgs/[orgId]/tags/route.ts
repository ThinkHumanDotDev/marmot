import { getPayload } from 'payload'
import { z } from 'zod'

import config from '@payload-config'
import { TAG_COLOR_PATTERN, TAG_COLORS } from '@/lib/monitor-resources'
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

const tagBodySchema = z.object({
  name: z.string().trim().min(1).max(100),
  color: z.string().regex(TAG_COLOR_PATTERN).optional(),
})

/** GET /api/orgs/:orgId/tags — the organization's monitor tags (`tag:read`), sorted by name. */
export async function GET(request: Request, { params }: RouteContext) {
  const payload = await getPayload({ config })
  const orgId = parseId(payload, (await params).orgId)

  const auth = await authenticate(payload, request)
  if (auth.response) return auth.response
  const forbidden = await authorize(payload, auth.user, orgId, 'tag:read')
  if (forbidden) return forbidden

  try {
    const { docs } = await payload.find({
      collection: 'tags',
      where: { organization: { equals: orgId } },
      sort: 'name',
      limit: 0,
      pagination: false,
      depth: 0,
      user: auth.user,
      overrideAccess: false,
    })
    return Response.json({ docs })
  } catch (error) {
    return payloadError(error, request)
  }
}

/**
 * POST /api/orgs/:orgId/tags — create a tag (`tag:create`). Body: `{ name, color? }` (hex colour,
 * default the first palette colour). Names are unique per organization (409 when taken).
 */
export async function POST(request: Request, { params }: RouteContext) {
  const payload = await getPayload({ config })
  const orgId = parseId(payload, (await params).orgId)

  const auth = await authenticate(payload, request)
  if (auth.response) return auth.response
  const forbidden = await authorize(payload, auth.user, orgId, 'tag:create')
  if (forbidden) return forbidden

  const parsed = tagBodySchema.safeParse(await readJson(request))
  if (!parsed.success) return validationError(parsed.error, request)

  const { totalDocs } = await payload.count({
    collection: 'tags',
    where: { and: [{ organization: { equals: orgId } }, { name: { equals: parsed.data.name } }] },
    overrideAccess: true,
  })
  if (totalDocs > 0) {
    return jsonError(409, errorText(request, 'tagNameTaken', { name: parsed.data.name }))
  }

  try {
    const doc = await payload.create({
      collection: 'tags',
      data: {
        name: parsed.data.name,
        color: parsed.data.color ?? TAG_COLORS[0].value,
        organization: orgId,
      } as never,
      user: auth.user,
      overrideAccess: false,
      depth: 0,
    })
    return Response.json(doc, { status: 201 })
  } catch (error) {
    return payloadError(error, request)
  }
}
