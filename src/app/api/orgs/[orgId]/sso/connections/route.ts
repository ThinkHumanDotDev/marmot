import type { Payload } from 'payload'
import { z } from 'zod'

import { ROLES } from '@/access/permissions'
import { SSO_CONNECTIONS_SLUG } from '@/collections/SsoConnections'
import type { SsoConnection } from '@/payload-types'
import {
  errorMessage,
  errorStatus,
  jsonError,
  readJson,
  resolveOrgRequest,
} from '@/server/notifications/api'
import { toConnectionRow } from '@/server/sso/connections'
import { errorText } from '@/server/request-locale'

export const dynamic = 'force-dynamic'

/** The row as stored (the client secret is stripped from access-checked reads). */
export const reloadConnection = (payload: Payload, id: SsoConnection['id']) =>
  payload.findByID({
    collection: SSO_CONNECTIONS_SLUG,
    id,
    depth: 0,
    overrideAccess: true,
  }) as Promise<SsoConnection>

type RouteContext = { params: Promise<{ orgId: string }> }

const optionalText = z.string().trim().max(4000).optional()

export const connectionSchema = z.object({
  name: z.string().trim().min(1, 'name is required').max(120),
  slug: z.string().trim().min(2).max(64),
  type: z.enum(['oidc', 'saml']),
  enabled: z.boolean().optional(),
  issuerUrl: z.string().trim().url().optional().or(z.literal('')),
  clientId: optionalText,
  clientSecret: optionalText,
  scopes: optionalText,
  idpEntryPoint: z.string().trim().url().optional().or(z.literal('')),
  idpEntityId: optionalText,
  idpCert: optionalText,
  wantAssertionsSigned: z.boolean().optional(),
  allowIdpInitiated: z.boolean().optional(),
  autoProvision: z.boolean().optional(),
  defaultRole: z.enum(ROLES.filter((role) => role !== 'owner') as [string, ...string[]]).optional(),
  groupClaim: z.string().trim().max(200).optional(),
  allowedGroups: optionalText,
  groupRoles: z
    .array(z.object({ group: z.string().trim().min(1).max(200), role: z.enum(ROLES) }))
    .max(100)
    .optional(),
})

/** GET /api/orgs/:orgId/sso/connections — the organization's connections (`sso:read`). */
export async function GET(request: Request, { params }: RouteContext) {
  const { orgId } = await params
  const ctx = await resolveOrgRequest(request, orgId, 'sso:read')
  if (ctx instanceof Response) return ctx

  // `sso:read` in this organization was checked above; the read bypasses field access so the row
  // can report whether a (never returned) client secret is stored.
  const { docs } = await ctx.payload.find({
    collection: SSO_CONNECTIONS_SLUG,
    where: { organization: { equals: ctx.orgId } },
    sort: 'name',
    depth: 0,
    limit: 100,
    overrideAccess: true,
  })
  return Response.json({ docs: (docs as SsoConnection[]).map(toConnectionRow) })
}

/** POST /api/orgs/:orgId/sso/connections — create a connection (`sso:manage`). */
export async function POST(request: Request, { params }: RouteContext) {
  const { orgId } = await params
  const ctx = await resolveOrgRequest(request, orgId, 'sso:manage')
  if (ctx instanceof Response) return ctx

  const body = await readJson(request)
  if (!body) return jsonError(400, errorText(request, 'invalidJsonBody'))
  const parsed = connectionSchema.safeParse(body)
  if (!parsed.success) {
    return jsonError(400, parsed.error.issues[0]?.message ?? errorText(request, 'validationFailed'))
  }

  try {
    const created = (await ctx.payload.create({
      collection: SSO_CONNECTIONS_SLUG,
      data: { ...parsed.data, organization: ctx.orgId } as never,
      depth: 0,
      user: ctx.user,
      overrideAccess: false,
    })) as SsoConnection
    return Response.json(
      { doc: toConnectionRow(await reloadConnection(ctx.payload, created.id)) },
      { status: 201 },
    )
  } catch (error) {
    return jsonError(errorStatus(error), errorMessage(error, request))
  }
}
