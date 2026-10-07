/**
 * Shared plumbing of the on-demand check routes (`POST /api/orgs/:orgId/monitors/:id/check` and
 * `POST /api/orgs/:orgId/checks`): who may trigger a check, the per-organization rate limit and the
 * mapping of a worker outcome to an HTTP response. The checks themselves run on the worker
 * (`src/server/engine/on-demand.ts`).
 */
import type { Payload } from 'payload'

import { canInOrg } from '@/access/overrides'
import type { Permission } from '@/access/permissions'
import { translateError } from '@/server/errors'
import type { OnDemandOutcome } from '@/server/engine/on-demand'
import { onDemandCheckLimiter } from '@/server/security/limiters'
import { rateLimitHeaders, tooManyRequests } from '@/server/security/rate-limit'
import { errorText, userLocale } from '@/server/request-locale'

import { authenticate, jsonError, type RequestUser, type RouteId } from './http'

/**
 * Who triggered a check. Only signed-in members today; organization API keys join here once they
 * may call the management API (#115): resolve the key with `authenticateApiKey`, require a scope
 * that allows checks, and return `{ kind: 'api-key', … }`.
 */
export type CheckActor = { kind: 'user'; user: RequestUser }

export type CheckActorResult = { actor: CheckActor; response?: undefined } | { response: Response }

/**
 * Authenticate the request and require one of `permissions` in `orgId` (401 / 403 otherwise).
 * Viewers hold none of the monitor write permissions, so they cannot trigger checks.
 */
export async function resolveCheckActor(
  payload: Payload,
  request: Request,
  orgId: RouteId,
  permissions: Permission[],
): Promise<CheckActorResult> {
  const auth = await authenticate(payload, request)
  if (auth.response) return { response: auth.response }
  for (const permission of permissions) {
    if (await canInOrg(payload, auth.user, orgId, permission)) {
      return { actor: { kind: 'user', user: auth.user } }
    }
  }
  return { response: jsonError(403, translateError(userLocale(auth.user), 'forbidden')) }
}

/** Spend one on-demand check of the organization's budget; a 429 response when it is used up. */
export async function consumeCheckBudget(
  request: Request,
  orgId: RouteId,
): Promise<{ headers: Record<string, string>; response?: Response }> {
  const decision = await onDemandCheckLimiter.consume(String(orgId))
  if (!decision.allowed) return { headers: {}, response: tooManyRequests(decision, request) }
  return { headers: rateLimitHeaders(decision) }
}

/** `?wait=false` / `?record=false` style flags; anything else keeps the default. */
export function queryFlag(request: Request, name: string, fallback: boolean): boolean {
  const raw = new URL(request.url).searchParams.get(name)
  if (raw === null) return fallback
  if (['false', '0', 'no'].includes(raw.toLowerCase())) return false
  if (['true', '1', 'yes'].includes(raw.toLowerCase())) return true
  return fallback
}

/** HTTP response for what the worker made of an on-demand job. */
export function outcomeResponse(
  request: Request,
  outcome: OnDemandOutcome,
  headers: Record<string, string>,
): Response {
  switch (outcome.kind) {
    case 'done':
      return Response.json(outcome.result, { headers })
    case 'skipped':
      switch (outcome.reason) {
        case 'not-found':
          return jsonError(404, errorText(request, 'monitorNotFound'))
        case 'inactive':
          return jsonError(409, errorText(request, 'monitorPausedNoCheck'))
        case 'not-applicable':
          return jsonError(409, errorText(request, 'checkNotApplicable'))
        default:
          return jsonError(504, errorText(request, 'checkTimedOut'))
      }
    case 'timeout':
      return jsonError(504, errorText(request, 'checkTimedOut'))
    default:
      return jsonError(500, errorText(request, 'checkFailed'))
  }
}
