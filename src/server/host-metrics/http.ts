/**
 * `POST /api/agent/v1/metrics` (#136): a host agent reports one sample. Authenticated with the
 * monitor's token (`Authorization: Bearer <token>`, the `pushToken` of a `host` monitor), rate
 * limited per monitor (`HOST_AGENT_RATE_LIMIT` per minute). Answers `{ ok: true, interval }` so the
 * agent follows the monitor's interval; `401` for unknown tokens, `409` while the monitor is
 * paused, `400` for a malformed sample, `413` for an oversized one and `429` when over the limit.
 */
import type { Payload } from 'payload'

import { env } from '@/env'
import { HOST_SAMPLE_MAX_BYTES, hostSampleSchema } from '@/lib/host-metrics'
import { childLogger } from '@/lib/logger'
import type { Monitor } from '@/payload-types'
import { readCappedBody } from '@/server/push/http'
import { createRateLimiter, type RateLimiter } from '@/server/security/rate-limit'

import { ingestHostSample } from './ingest'

const log = childLogger('host-agent')

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{8,128}$/

let limiter: RateLimiter | null | undefined

function hostAgentLimiter(): RateLimiter | null {
  if (limiter === undefined) {
    limiter =
      env.HOST_AGENT_RATE_LIMIT > 0
        ? createRateLimiter('host-agent', { points: env.HOST_AGENT_RATE_LIMIT, duration: 60 })
        : null
  }
  return limiter
}

/** The token of `Authorization: Bearer <token>`, or `null`. */
export function extractHostToken(headers: Headers): string | null {
  const authorization = headers.get('authorization')
  if (!authorization) return null
  const [scheme, value, ...rest] = authorization.trim().split(/\s+/)
  if (scheme?.toLowerCase() !== 'bearer' || !value || rest.length > 0) return null
  return TOKEN_PATTERN.test(value) ? value : null
}

/** The host monitor whose token is `token`, active or not, or `null`. */
export async function findHostMonitor(payload: Payload, token: string): Promise<Monitor | null> {
  const { docs } = await payload.find({
    collection: 'monitors',
    where: { and: [{ pushToken: { equals: token } }, { type: { equals: 'host' } }] },
    depth: 0,
    limit: 1,
    overrideAccess: true,
  })
  return (docs[0] as Monitor | undefined) ?? null
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { 'Cache-Control': 'no-store', ...headers } })

export async function handleHostMetricsRequest(
  payload: Payload,
  request: Request,
  now: Date = new Date(),
): Promise<Response> {
  const token = extractHostToken(request.headers)
  const monitor = token ? await findHostMonitor(payload, token) : null
  if (!monitor) {
    return json({ ok: false, error: 'invalid host token' }, 401, {
      'WWW-Authenticate': 'Bearer realm="marmot-host-agent"',
    })
  }

  const decision = await hostAgentLimiter()?.consume(String(monitor.id))
  if (decision && !decision.allowed) {
    return json({ ok: false, error: 'rate limited' }, 429, {
      'Retry-After': String(decision.retryAfterSeconds),
    })
  }
  if (monitor.active === false) {
    return json({ ok: false, error: 'monitor is paused', interval: monitor.interval }, 409)
  }

  const body = await readCappedBody(request, HOST_SAMPLE_MAX_BYTES)
  if (body.truncated) return json({ ok: false, error: 'sample too large' }, 413)
  let raw: unknown
  try {
    raw = JSON.parse(body.text ?? '')
  } catch {
    return json({ ok: false, error: 'body must be a JSON sample' }, 400)
  }
  const parsed = hostSampleSchema.safeParse(raw)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    return json(
      { ok: false, error: `${issue?.path.join('.') || 'sample'}: ${issue?.message ?? 'invalid'}` },
      400,
    )
  }

  await ingestHostSample(payload, monitor, parsed.data, now)
  log.debug({ monitorId: monitor.id, hostname: parsed.data.hostname }, 'host sample received')
  return json({ ok: true, interval: monitor.interval })
}
