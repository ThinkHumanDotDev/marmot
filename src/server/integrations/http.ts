/**
 * `POST /api/inbound/<token>` (#152): alerts from Alertmanager, Grafana or any JSON sender.
 *
 * - **Authentication**: the token in the URL is the secret. It is looked up by its SHA-256 and
 *   compared in constant time; unknown, malformed and paused tokens all get the same `404`.
 * - **Rate limit**: `INBOUND_ALERT_RATE_LIMIT` requests per minute per token (and per client address
 *   behind a trusted proxy), checked before the database is touched; `429` with `Retry-After`.
 * - **Size**: bodies over `INBOUND_ALERT_MAX_BYTES` get `413` without being buffered; at most
 *   `MAX_ALERTS_PER_PAYLOAD` alerts are read from one payload.
 * - **Idempotency**: alerts are keyed by their dedup key (`./ingest.ts`), so a retried delivery
 *   answers `200` again without opening anything twice.
 *
 * Answers `200 { ok: true, alerts, results: [{ dedupKey, status, outcome }] }`, `400` for a body
 * that is not JSON in the integration's format.
 */
import type { Payload } from 'payload'

import { env } from '@/env'
import { childLogger } from '@/lib/logger'
import { isIntegrationToken, parseInboundPayload, type GenericMapping } from '@/lib/inbound-alerts'
import type { Integration } from '@/payload-types'
import { readBody } from '@/server/push/inbound-webhook'
import {
  createRateLimiter,
  rateLimitHeaders,
  tooManyRequests,
  type RateLimiter,
} from '@/server/security/rate-limit'
import { requestMeta } from '@/server/security/request'

import { ingestAlerts } from './ingest'
import { hashIntegrationToken, integrationTokenMatches } from './token'

const log = childLogger('integrations:http')

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { 'Cache-Control': 'no-store', ...headers } })

let limiter: { points: number; instance: RateLimiter } | null = null

/** The limiter for the current `INBOUND_ALERT_RATE_LIMIT` (`null` when it is 0). */
function inboundLimiter(): RateLimiter | null {
  const points = env.INBOUND_ALERT_RATE_LIMIT
  if (points <= 0) return null
  if (limiter?.points !== points) {
    limiter = { points, instance: createRateLimiter('inbound-alerts', { points, duration: 60 }) }
  }
  return limiter.instance
}

/** The active integration owning `token`, or `null`. */
export async function findIntegrationByToken(
  payload: Payload,
  token: string,
): Promise<Integration | null> {
  if (!isIntegrationToken(token)) return null
  const hash = hashIntegrationToken(token)
  const { docs } = await payload.find({
    collection: 'integrations',
    where: { tokenHash: { equals: hash } },
    depth: 0,
    limit: 1,
    overrideAccess: true,
    showHiddenFields: true,
  })
  const integration = docs[0] as Integration | undefined
  if (!integration?.tokenHash || !integrationTokenMatches(token, integration.tokenHash)) return null
  return integration.active === false ? null : integration
}

export async function handleInboundAlert(
  payload: Payload,
  request: Request,
  rawToken: string,
): Promise<Response> {
  const token = rawToken.trim().toLowerCase()
  const notFound = () => json({ ok: false, error: 'Unknown integration.' }, 404)

  let rateHeaders: Record<string, string> = {}
  const bucket = inboundLimiter()
  if (bucket) {
    const { ip } = await requestMeta(payload, request)
    const keys = [`tok:${hashIntegrationToken(token).slice(0, 32)}`, ...(ip ? [`ip:${ip}`] : [])]
    for (const key of keys) {
      const decision = await bucket.consume(key)
      if (!decision.allowed) return tooManyRequests(decision, request)
      if (!decision.degraded) rateHeaders = rateLimitHeaders(decision)
    }
  }

  const integration = await findIntegrationByToken(payload, token)
  if (!integration) return notFound()

  const limit = env.INBOUND_ALERT_MAX_BYTES
  const declared = Number(request.headers.get('content-length') ?? 0)
  const body = declared > limit ? null : await readBody(request, limit)
  if (!body) {
    return json({ ok: false, error: `Payload exceeds the ${limit} byte limit.` }, 413, rateHeaders)
  }

  let raw: unknown
  let parsed
  try {
    raw = JSON.parse(Buffer.from(body).toString('utf8')) as unknown
    parsed = parseInboundPayload(
      integration.format,
      raw,
      (integration.generic ?? {}) as GenericMapping,
    )
  } catch (err) {
    log.info(
      { err: err instanceof Error ? err.message : String(err), integration: integration.id },
      'unreadable inbound alert payload',
    )
    return json(
      { ok: false, error: 'Payload must be JSON in the integration format.' },
      400,
      rateHeaders,
    )
  }

  const results = await ingestAlerts(payload, integration, parsed, { source: 'webhook', raw })
  return json(
    {
      ok: true,
      alerts: results.length,
      dropped: parsed.dropped,
      results: results.map(({ dedupKey, status, outcome }) => ({ dedupKey, status, outcome })),
    },
    200,
    rateHeaders,
  )
}
