import type { Redis } from 'ioredis'
import { RateLimiterRedis, RateLimiterRes } from 'rate-limiter-flexible'

import { childLogger } from '@/lib/logger'
import { createRedis } from '@/server/redis'

const log = childLogger('rate-limit')

/** Redis key prefix shared by every limiter so `redis-cli --scan --pattern 'marmot:rl:*'` finds them. */
export const RATE_LIMIT_PREFIX = 'marmot:rl'

export interface RateLimiterOptions {
  /** Requests allowed per `duration`. */
  points: number
  /** Window length in seconds. */
  duration: number
  /** How long (seconds) a key stays blocked once it runs out of points. Defaults to `duration`. */
  blockDuration?: number
}

export interface RateLimitDecision {
  allowed: boolean
  /** `points` of the limiter, for `X-RateLimit-Limit`. */
  limit: number
  /** Points left in the current window, for `X-RateLimit-Remaining`. */
  remaining: number
  /** Seconds until the next request may succeed (0 when allowed), for `Retry-After`. */
  retryAfterSeconds: number
  /** True when Redis was unreachable and the request was let through unchecked. */
  degraded: boolean
}

export interface RateLimiter {
  readonly name: string
  readonly points: number
  readonly duration: number
  /** Spend one point for `key` and report whether the caller may proceed. Never throws. */
  consume(key: string): Promise<RateLimitDecision>
}

/** The subset of ioredis the limiter needs; lets tests pass a stub. */
export type RateLimitStore = Pick<Redis, 'multi' | 'defineCommand' | 'status'> &
  Record<string, unknown>

let sharedClient: Redis | undefined

/**
 * One Redis connection for every limiter in the process. Commands time out quickly so an outage
 * degrades the limiter (see `createRateLimiter`) instead of stalling logins.
 */
function getSharedClient(): Redis {
  sharedClient ??= createRedis({ maxRetriesPerRequest: 1, commandTimeout: 1_000 })
  return sharedClient
}

/** Closes the shared connection (tests, graceful shutdown). */
export async function closeRateLimitStore(): Promise<void> {
  const client = sharedClient
  sharedClient = undefined
  if (client) await client.quit().catch(() => undefined)
}

const retryAfter = (msBeforeNext: number) => Math.max(1, Math.ceil(msBeforeNext / 1000))

/**
 * Redis-backed fixed-window limiter (`rate-limiter-flexible`). Keys are namespaced by `name`.
 *
 * When Redis is unavailable the limiter fails open: the request is allowed and a single warning is
 * logged until the store answers again. Brute-force protection is worth less than keeping a status
 * monitor's own login reachable during an infrastructure incident.
 */
export function createRateLimiter(
  name: string,
  options: RateLimiterOptions,
  deps: { client?: RateLimitStore } = {},
): RateLimiter {
  const blockDuration = options.blockDuration ?? options.duration
  let limiter: RateLimiterRedis | undefined
  let degradedSince: number | null = null

  const getLimiter = () => {
    limiter ??= new RateLimiterRedis({
      storeClient: deps.client ?? getSharedClient(),
      keyPrefix: `${RATE_LIMIT_PREFIX}:${name}`,
      points: options.points,
      duration: options.duration,
      blockDuration,
      // Not `rejectIfRedisNotReady`: a fresh connection is "connecting" for a few ms and ioredis
      // queues the command; `commandTimeout` on the shared client bounds how long that can take.
    })
    return limiter
  }

  return {
    name,
    points: options.points,
    duration: options.duration,
    async consume(key) {
      try {
        const res = await getLimiter().consume(key, 1)
        if (degradedSince !== null) {
          log.info({ limiter: name }, 'rate limiting restored')
          degradedSince = null
        }
        return {
          allowed: true,
          limit: options.points,
          remaining: res.remainingPoints,
          retryAfterSeconds: 0,
          degraded: false,
        }
      } catch (error) {
        if (error instanceof RateLimiterRes) {
          return {
            allowed: false,
            limit: options.points,
            remaining: 0,
            retryAfterSeconds: retryAfter(error.msBeforeNext),
            degraded: false,
          }
        }
        if (degradedSince === null) {
          degradedSince = Date.now()
          log.warn(
            { limiter: name, err: error instanceof Error ? error.message : String(error) },
            'rate limit store unavailable; allowing requests unchecked until it recovers',
          )
        }
        return {
          allowed: true,
          limit: options.points,
          remaining: options.points,
          retryAfterSeconds: 0,
          degraded: true,
        }
      }
    },
  }
}

export interface ClientIpOptions {
  /**
   * Whether `X-Forwarded-For` / `X-Real-IP` may be believed. Only enable behind a reverse proxy
   * that overwrites those headers (the instance setting `trustProxy`); otherwise any client could
   * pick its own rate-limit bucket.
   */
  trustProxy: boolean
}

const isPlausibleIp = (value: string) => /^[0-9a-fA-F.:]+$/.test(value) && value.length <= 45

/**
 * Best-effort client address of a request. Next.js route handlers do not expose the socket
 * address, so without a trusted proxy header there is nothing to return (`null`); callers then
 * fall back to another key (the account being logged into) or skip limiting.
 */
export function clientIp(
  request: { headers: Headers },
  { trustProxy }: ClientIpOptions,
): string | null {
  if (!trustProxy) return null
  const forwarded = request.headers.get('x-forwarded-for')
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim() ?? ''
    if (isPlausibleIp(first)) return first
  }
  const real = request.headers.get('x-real-ip')?.trim()
  if (real && isPlausibleIp(real)) return real
  return null
}

export interface WithRateLimitOptions<Args extends unknown[]> {
  /**
   * Bucket for the request. Return `null` to skip limiting (for example when the client address is
   * unknown and there is no other sensible key).
   */
  keyFrom: (request: Request, ...rest: Args) => Promise<string | null> | string | null
}

export function rateLimitHeaders(decision: RateLimitDecision): Record<string, string> {
  const headers: Record<string, string> = {
    'X-RateLimit-Limit': String(decision.limit),
    'X-RateLimit-Remaining': String(decision.remaining),
  }
  if (!decision.allowed) headers['Retry-After'] = String(decision.retryAfterSeconds)
  return headers
}

/** JSON 429 response with `Retry-After` and `X-RateLimit-*` headers. */
export function tooManyRequests(decision: RateLimitDecision): Response {
  return Response.json(
    { errors: [{ message: 'Too many requests. Please try again later.' }] },
    { status: 429, headers: rateLimitHeaders(decision) },
  )
}

function withHeaders(response: Response, headers: Record<string, string>): Response {
  const merged = new Headers(response.headers)
  for (const [key, value] of Object.entries(headers)) merged.set(key, value)
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: merged,
  })
}

/**
 * Wraps a Next.js route handler: consumes a point for `keyFrom(request)` before running it,
 * answers 429 (+ `Retry-After`, `X-RateLimit-Limit`, `X-RateLimit-Remaining`) when the bucket is
 * empty, and stamps the `X-RateLimit-*` headers on successful responses.
 */
export function withRateLimit<Args extends unknown[]>(
  handler: (request: Request, ...rest: Args) => Promise<Response> | Response,
  limiter: RateLimiter,
  { keyFrom }: WithRateLimitOptions<Args>,
): (request: Request, ...rest: Args) => Promise<Response> {
  return async (request, ...rest) => {
    const key = await keyFrom(request, ...rest)
    if (key === null) return handler(request, ...rest)

    const decision = await limiter.consume(key)
    if (!decision.allowed) return tooManyRequests(decision)

    const response = await handler(request, ...rest)
    return decision.degraded ? response : withHeaders(response, rateLimitHeaders(decision))
  }
}
