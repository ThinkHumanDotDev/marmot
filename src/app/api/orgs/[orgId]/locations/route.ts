import type { Location } from '@/payload-types'
import { listLocationRows, toLocationRow } from '@/server/probes'
import { locationCreateSchema } from '@/server/probes/schemas'
import { generateProbeToken } from '@/server/probes/tokens'
import {
  errorMessage,
  errorStatus,
  jsonError,
  readJson,
  resolveOrgRequest,
} from '@/server/notifications/api'
import { errorText } from '@/server/request-locale'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ orgId: string }> }

/** GET /api/orgs/:orgId/locations — the organization's probe locations by name (`location:read`). */
export async function GET(request: Request, { params }: RouteContext) {
  const { orgId } = await params
  const ctx = await resolveOrgRequest(request, orgId, 'location:read')
  if (ctx instanceof Response) return ctx
  const docs = await listLocationRows(ctx.payload, ctx.orgId, {
    user: ctx.user,
    overrideAccess: false,
  })
  return Response.json({ docs })
}

/**
 * POST /api/orgs/:orgId/locations — create a probe location (`location:create`). The response
 * carries the plaintext `token` exactly once; only its hash is stored.
 */
export async function POST(request: Request, { params }: RouteContext) {
  const { orgId } = await params
  const ctx = await resolveOrgRequest(request, orgId, 'location:create')
  if (ctx instanceof Response) return ctx

  const body = await readJson(request)
  if (!body) return jsonError(400, errorText(request, 'invalidJsonBody'))
  const parsed = locationCreateSchema.safeParse(body)
  if (!parsed.success) {
    return jsonError(400, parsed.error.issues[0]?.message ?? errorText(request, 'validationFailed'))
  }

  const generated = generateProbeToken()
  try {
    // The permission was checked above; the token and bookkeeping fields are server-only, so the
    // write bypasses field access on purpose. `user` names the actor in the audit log.
    const doc = (await ctx.payload.create({
      collection: 'locations',
      data: {
        organization: ctx.orgId as Location['organization'],
        name: parsed.data.name,
        ...(parsed.data.slug ? { slug: parsed.data.slug } : {}),
        labels: parsed.data.labels.map((row) => ({ key: row.key, value: row.value ?? null })),
        tokenHash: generated.tokenHash,
        tokenPrefix: generated.prefix,
        status: 'unknown',
        createdBy: ctx.user.id as Location['createdBy'],
      } as Location,
      depth: 0,
      user: ctx.user,
      overrideAccess: true,
    })) as Location
    return Response.json({ doc: toLocationRow(doc), token: generated.token }, { status: 201 })
  } catch (error) {
    return jsonError(errorStatus(error), errorMessage(error, request))
  }
}
