import { createLocalReq, getPayload } from 'payload'

import config from '@payload-config'
import { supportsAdhocTest } from '@/lib/on-demand-check'
import { monitorFormSchema } from '@/lib/validation/monitor-schema'
import type { Monitor } from '@/payload-types'
import {
  enqueueOnDemandCheck,
  onDemandWaitMs,
  waitForOnDemandCheck,
} from '@/server/engine/on-demand'
import { ADHOC_CHECK_JOB_NAME } from '@/server/engine/names'
import { consumeCheckBudget, outcomeResponse, resolveCheckActor } from '@/server/monitors/checks'
import { jsonError, parseId, readJson, relationId, validationError } from '@/server/monitors/http'
import { errorText } from '@/server/request-locale'
import { monitorTargetProblem } from '@/server/security/monitor-targets'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ orgId: string }> }

/** Relationship fields an ad-hoc check may use; they must belong to the organization. */
const REFERENCES = [
  { field: 'proxy', collection: 'proxies' },
  { field: 'dockerHost', collection: 'docker-hosts' },
] as const

/**
 * POST /api/orgs/:orgId/checks — run a check of an unsaved monitor configuration ("Test" in the
 * monitor form) and return the result without storing anything.
 *
 * Body: monitor form values (`monitorFormSchema`, as for `POST /api/orgs/:orgId/monitors`). The
 * worker runs the check with the configured timeout; the outbound address guard applies (literal
 * private targets are refused here with 400, names when the worker connects). Push, group and manual
 * monitors cannot be tested (400). Answers `OnDemandCheckResult`, 504 when no result arrives in time.
 *
 * Needs `monitor:create` or `monitor:update`; shares the per-organization budget with "Check now".
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
  const parsed = monitorFormSchema.safeParse(body)
  if (!parsed.success) return validationError(parsed.error, request)
  const values = parsed.data as unknown as Partial<Monitor>
  if (!supportsAdhocTest(values.type)) {
    return jsonError(400, errorText(request, 'adhocTypeNotSupported'))
  }

  // Another organization's proxy (with its credentials) or Docker host is not available.
  for (const { field, collection } of REFERENCES) {
    const refId = relationId(values[field])
    if (refId === null) continue
    const doc = await payload
      .findByID({ collection, id: refId, depth: 0, overrideAccess: true })
      .catch(() => null)
    if (!doc || String(relationId(doc.organization)) !== String(orgId)) {
      return jsonError(400, errorText(request, 'validationFailed'), {
        issues: [{ path: field, message: errorText(request, 'monitorForeignReference') }],
      })
    }
  }

  const req = await createLocalReq({ user: actor.user }, payload)
  const problem = await monitorTargetProblem({ ...values, organization: orgId } as Monitor, req)
  if (problem) {
    return jsonError(400, errorText(request, 'validationFailed'), {
      issues: [{ path: problem.path, message: problem.message }],
    })
  }

  const budget = await consumeCheckBudget(request, orgId)
  if (budget.response) return budget.response

  const waitMs = onDemandWaitMs({ timeout: values.timeout ?? 0, interval: values.interval ?? 60 })
  let job
  try {
    job = await enqueueOnDemandCheck(
      {
        name: ADHOC_CHECK_JOB_NAME,
        data: { organizationId: String(orgId), monitor: values, deadline: Date.now() + waitMs },
      },
      waitMs,
    )
  } catch {
    return jsonError(503, errorText(request, 'checkFailed'))
  }
  return outcomeResponse(request, await waitForOnDemandCheck(job, waitMs), budget.headers)
}
