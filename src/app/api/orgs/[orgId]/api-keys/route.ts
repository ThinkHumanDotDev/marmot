import { z } from 'zod'

import type { ApiKey } from '@/payload-types'
import { generateApiKey, toApiKeyRow } from '@/server/api-keys'
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

const MAX_EXPIRY_DAYS = 3650

const createSchema = z.object({
  name: z.string().trim().min(1, 'name is required').max(120),
  /** ISO date, or `null`/omitted for a key that never expires. */
  expiresAt: z.iso.datetime({ offset: true }).nullable().optional(),
  /** Convenience for the UI: expire this many days from now. */
  expiresInDays: z.number().int().positive().max(MAX_EXPIRY_DAYS).nullable().optional(),
})

/** GET /api/orgs/:orgId/api-keys — the organization's keys, newest first (`api-key:read`). */
export async function GET(request: Request, { params }: RouteContext) {
  const { orgId } = await params
  const ctx = await resolveOrgRequest(request, orgId, 'api-key:read')
  if (ctx instanceof Response) return ctx

  const { docs } = await ctx.payload.find({
    collection: 'api-keys',
    where: { organization: { equals: ctx.orgId } },
    sort: '-createdAt',
    depth: 0,
    limit: 200,
    user: ctx.user,
    overrideAccess: false,
  })
  return Response.json({ docs: (docs as ApiKey[]).map((doc) => toApiKeyRow(doc)) })
}

/**
 * POST /api/orgs/:orgId/api-keys — mint a key (`api-key:create`). The response carries the
 * plaintext `key` exactly once; only its hash is stored.
 */
export async function POST(request: Request, { params }: RouteContext) {
  const { orgId } = await params
  const ctx = await resolveOrgRequest(request, orgId, 'api-key:create')
  if (ctx instanceof Response) return ctx

  const body = await readJson(request)
  if (!body) return jsonError(400, errorText(request, 'invalidJsonBody'))
  const parsed = createSchema.safeParse(body)
  if (!parsed.success) {
    return jsonError(400, parsed.error.issues[0]?.message ?? errorText(request, 'validationFailed'))
  }

  const expiresAt =
    parsed.data.expiresAt ??
    (parsed.data.expiresInDays
      ? new Date(Date.now() + parsed.data.expiresInDays * 86_400_000).toISOString()
      : null)
  if (expiresAt && new Date(expiresAt).getTime() <= Date.now()) {
    return jsonError(400, errorText(request, 'expiresAtInPast'))
  }

  const generated = generateApiKey()
  try {
    // The permission was checked above; `keyHash`/`prefix`/`createdBy` are server-only fields, so
    // the write bypasses field access on purpose.
    const doc = (await ctx.payload.create({
      collection: 'api-keys',
      data: {
        organization: ctx.orgId as ApiKey['organization'],
        name: parsed.data.name,
        keyHash: generated.keyHash,
        prefix: generated.prefix,
        active: true,
        expiresAt,
        createdBy: ctx.user.id as ApiKey['createdBy'],
      },
      depth: 0,
      overrideAccess: true,
    })) as ApiKey
    return Response.json({ doc: toApiKeyRow(doc), key: generated.key }, { status: 201 })
  } catch (error) {
    return jsonError(errorStatus(error), errorMessage(error, request))
  }
}
