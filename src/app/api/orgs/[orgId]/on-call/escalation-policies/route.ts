import { getPayload } from 'payload'

import config from '@payload-config'
import { policySchema } from '@/lib/validation/on-call'
import type { EscalationPolicy } from '@/payload-types'
import {
  authenticate,
  authorize,
  parseId,
  payloadError,
  readJson,
  validationError,
} from '@/server/monitors/http'
import { assignPolicyMonitors, policyData } from '@/server/on-call/http'
import { listPolicies, serializePolicies } from '@/server/on-call/store'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ orgId: string }> }

/** GET /api/orgs/:orgId/on-call/escalation-policies — the organization's policies, by name. */
export async function GET(request: Request, { params }: RouteContext) {
  const payload = await getPayload({ config })
  const orgId = parseId(payload, (await params).orgId)
  const auth = await authenticate(payload, request)
  if (auth.response) return auth.response
  const forbidden = await authorize(payload, auth.user, orgId, 'escalation-policy:read')
  if (forbidden) return forbidden
  try {
    const docs = await listPolicies(payload, orgId, auth.user)
    return Response.json({ docs: await serializePolicies(payload, docs) })
  } catch (error) {
    return payloadError(error, request)
  }
}

/**
 * POST /api/orgs/:orgId/on-call/escalation-policies — create a policy. Body: `{ name,
 * description?, repeat?, steps: [{ escalateAfterMinutes, targets: [{ type, id }] }], monitors? }`.
 */
export async function POST(request: Request, { params }: RouteContext) {
  const payload = await getPayload({ config })
  const orgId = parseId(payload, (await params).orgId)
  const auth = await authenticate(payload, request)
  if (auth.response) return auth.response
  const forbidden = await authorize(payload, auth.user, orgId, 'escalation-policy:manage')
  if (forbidden) return forbidden

  const parsed = policySchema.safeParse(await readJson(request))
  if (!parsed.success) return validationError(parsed.error, request)
  try {
    const doc = (await payload.create({
      collection: 'escalation-policies',
      data: policyData(payload, parsed.data, orgId) as never,
      depth: 0,
      user: auth.user,
      overrideAccess: false,
    })) as EscalationPolicy
    if (parsed.data.monitors) {
      await assignPolicyMonitors(payload, auth.user, orgId, doc.id, parsed.data.monitors)
    }
    const [summary] = await serializePolicies(payload, [doc])
    return Response.json(summary, { status: 201 })
  } catch (error) {
    return payloadError(error, request)
  }
}
