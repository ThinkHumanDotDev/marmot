import { createLocalReq, getPayload } from 'payload'
import { z } from 'zod'

import config from '@payload-config'
import { STATUS_PAGE_PROVIDERS } from '@/lib/validation/status-page-monitor'
import type { Monitor } from '@/payload-types'
import { fetchVendorStatus } from '@/server/monitor-types/status-page-fetch'
import { consumeCheckBudget, resolveCheckActor } from '@/server/monitors/checks'
import { jsonError, parseId, readJson, validationError } from '@/server/monitors/http'
import { errorText } from '@/server/request-locale'
import { findBlockedMessage } from '@/server/security/outbound-guard'
import { monitorTargetProblem } from '@/server/security/monitor-targets'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ orgId: string }> }

const bodySchema = z.object({
  url: z
    .string()
    .trim()
    .regex(/^https?:\/\/\S+$/i),
  provider: z.enum(STATUS_PAGE_PROVIDERS).default('auto'),
})

/** How long the form waits for the vendor before giving up. */
const LOOKUP_TIMEOUT_MS = 15_000

/**
 * POST /api/orgs/:orgId/status-page-components `{ url, provider? }` — reads a vendor status page
 * once and returns its detected format, name, overall state and components, so the monitor form
 * can offer the component filter (#125). Nothing is stored.
 *
 * Needs `monitor:create` or `monitor:update`; shares the per-organization budget with "Check now".
 * The outbound address guard applies to the URL and every redirect.
 */
export async function POST(request: Request, { params }: RouteContext) {
  const payload = await getPayload({ config })
  const orgId = parseId(payload, (await params).orgId)

  const resolved = await resolveCheckActor(payload, request, orgId, [
    'monitor:create',
    'monitor:update',
  ])
  if (resolved.response) return resolved.response
  const { actor } = resolved

  const body = await readJson(request)
  if (!body || typeof body !== 'object') {
    return jsonError(400, errorText(request, 'expectedJsonBody'))
  }
  const parsed = bodySchema.safeParse(body)
  if (!parsed.success) return validationError(parsed.error, request)

  const req = await createLocalReq({ user: actor.user }, payload)
  const problem = await monitorTargetProblem(
    { type: 'status-page', url: parsed.data.url, organization: orgId } as Monitor,
    req,
  )
  if (problem) {
    return jsonError(400, errorText(request, 'validationFailed'), {
      issues: [{ path: 'url', message: problem.message }],
    })
  }

  const budget = await consumeCheckBudget(request, orgId)
  if (budget.response) return budget.response

  try {
    const result = await fetchVendorStatus(
      parsed.data.url,
      parsed.data.provider,
      AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
    )
    return Response.json(
      {
        provider: result.provider,
        pageName: result.status.pageName,
        indicator: result.status.indicator,
        components: result.status.components,
      },
      { headers: budget.headers },
    )
  } catch (err) {
    const message = findBlockedMessage(err) ?? (err instanceof Error ? err.message : String(err))
    return Response.json({ errors: [{ message }] }, { status: 422, headers: budget.headers })
  }
}
