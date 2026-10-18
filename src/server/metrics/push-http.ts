import { apiKeyOf } from '@/server/auth/request-auth'
import {
  errorMessage,
  errorStatus,
  jsonError,
  readJson,
  resolveOrgRequest,
} from '@/server/notifications/api'
import { errorText } from '@/server/request-locale'
import { tooManyRequests, type RateLimiter } from '@/server/security/rate-limit'

import { getInstanceSettings } from '@/server/settings'

import { ingestPoints, maxPointAgeSeconds, pointProblem, pointTime } from './ingest'
import { loadOrgMetric } from './manage'
import { metricPointsSchema, pointsOf } from './schemas'

/**
 * The push handler with an injectable limiter (tests pass their own).
 *
 * POST /api/orgs/:orgId/metrics/:id/points `{ points: [{ value, timestamp? }] }` or
 * `{ value, timestamp? }` (`metric:push`; a `write` API key). Up to 1 000 points per request,
 * folded into the minutely, hourly and daily rollups; points older than 24 hours are backfilled into
 * the hourly (30 days) and daily (the data period) rollups only (#280). Rate limited per key (or
 * user) and metric (`METRIC_PUSH_RATE_LIMIT`), on top of the API key write budget. `202
 * { accepted }`.
 */
export async function handlePush(
  request: Request,
  rawOrgId: string,
  rawId: string,
  limiter: RateLimiter | null,
): Promise<Response> {
  const ctx = await resolveOrgRequest(request, rawOrgId, 'metric:push')
  if (ctx instanceof Response) return ctx

  const metric = await loadOrgMetric(ctx, rawId)
  if (!metric) return jsonError(404, errorText(request, 'metricNotFound'))
  if (metric.source === 'monitor') return jsonError(409, errorText(request, 'metricNotPushable'))

  if (limiter) {
    const principal = apiKeyOf(ctx.user)?.id ?? String(ctx.user.id)
    const decision = await limiter.consume(`${principal}:${String(metric.id)}`)
    if (!decision.allowed) return tooManyRequests(decision, request)
  }

  const body = await readJson(request)
  if (!body) return jsonError(400, errorText(request, 'invalidJsonBody'))
  const parsed = metricPointsSchema.safeParse(body)
  if (!parsed.success) {
    return jsonError(400, parsed.error.issues[0]?.message ?? errorText(request, 'validationFailed'))
  }

  const now = new Date()
  const { keepDataPeriodDays } = await getInstanceSettings(ctx.payload)
  const maxAge = maxPointAgeSeconds(keepDataPeriodDays)
  const points = pointsOf(parsed.data).map((point) => ({
    value: point.value,
    at: pointTime(point, now),
  }))
  for (const [index, point] of points.entries()) {
    const problem = pointProblem(point.at, now, maxAge)
    if (problem) {
      return jsonError(
        400,
        errorText(request, problem, { index, days: Math.round(maxAge / 86400) }),
      )
    }
  }

  try {
    return Response.json(await ingestPoints(ctx.payload, metric, points, now), { status: 202 })
  } catch (error) {
    return jsonError(errorStatus(error), errorMessage(error, request))
  }
}
