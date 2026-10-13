import { getPayload } from 'payload'

import config from '@payload-config'
import { updatePolicySchema } from '@/lib/validation/on-call'
import type { EscalationPolicy } from '@/payload-types'
import {
  authenticate,
  authorize,
  jsonError,
  parseId,
  payloadError,
  readJson,
  validationError,
} from '@/server/monitors/http'
import { assignPolicyMonitors, policyData } from '@/server/on-call/http'
import { loadOrgPolicy, serializePolicies } from '@/server/on-call/store'
import { errorText } from '@/server/request-locale'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ orgId: string; id: string }> }

/** GET /api/orgs/:orgId/on-call/escalation-policies/:id */
export async function GET(request: Request, { params }: RouteContext) {
  const payload = await getPayload({ config })
  const { orgId: rawOrgId, id } = await params
  const orgId = parseId(payload, rawOrgId)
  const auth = await authenticate(payload, request)
  if (auth.response) return auth.response
  const forbidden = await authorize(payload, auth.user, orgId, 'escalation-policy:read')
  if (forbidden) return forbidden

  const doc = await loadOrgPolicy(payload, auth.user, orgId, parseId(payload, id))
  if (!doc) return jsonError(404, errorText(request, 'onCallNotFound'))
  const [summary] = await serializePolicies(payload, [doc])
  return Response.json(summary)
}

/**
 * PATCH /api/orgs/:orgId/on-call/escalation-policies/:id — change `name`, `description`,
 * `repeat`, `steps` (replaces them) or `monitors` (the exact set of monitors using the policy).
 */
export async function PATCH(request: Request, { params }: RouteContext) {
  const payload = await getPayload({ config })
  const { orgId: rawOrgId, id } = await params
  const orgId = parseId(payload, rawOrgId)
  const auth = await authenticate(payload, request)
  if (auth.response) return auth.response
  const forbidden = await authorize(payload, auth.user, orgId, 'escalation-policy:manage')
  if (forbidden) return forbidden

  const parsed = updatePolicySchema.safeParse(await readJson(request))
  if (!parsed.success) return validationError(parsed.error, request)
  const existing = await loadOrgPolicy(payload, auth.user, orgId, parseId(payload, id))
  if (!existing) return jsonError(404, errorText(request, 'onCallNotFound'))
  try {
    const data = policyData(payload, parsed.data)
    const doc =
      Object.keys(data).length > 0
        ? ((await payload.update({
            collection: 'escalation-policies',
            id: existing.id,
            data: data as never,
            depth: 0,
            user: auth.user,
            overrideAccess: false,
          })) as EscalationPolicy)
        : existing
    if (parsed.data.monitors) {
      await assignPolicyMonitors(payload, auth.user, orgId, doc.id, parsed.data.monitors)
    }
    const [summary] = await serializePolicies(payload, [doc])
    return Response.json(summary)
  } catch (error) {
    return payloadError(error, request)
  }
}

/** DELETE /api/orgs/:orgId/on-call/escalation-policies/:id — its monitors stop escalating. */
export async function DELETE(request: Request, { params }: RouteContext) {
  const payload = await getPayload({ config })
  const { orgId: rawOrgId, id } = await params
  const orgId = parseId(payload, rawOrgId)
  const auth = await authenticate(payload, request)
  if (auth.response) return auth.response
  const forbidden = await authorize(payload, auth.user, orgId, 'escalation-policy:manage')
  if (forbidden) return forbidden

  const existing = await loadOrgPolicy(payload, auth.user, orgId, parseId(payload, id))
  if (!existing) return jsonError(404, errorText(request, 'onCallNotFound'))
  try {
    await assignPolicyMonitors(payload, auth.user, orgId, existing.id, [])
    await payload.delete({
      collection: 'escalation-policies',
      id: existing.id,
      user: auth.user,
      overrideAccess: false,
    })
    return new Response(null, { status: 204 })
  } catch (error) {
    return payloadError(error, request)
  }
}
