import { afterAll, describe, expect, it } from 'vitest'

import {
  clientIp,
  closeRateLimitStore,
  createRateLimiter,
  withRateLimit,
  type RateLimitStore,
} from './rate-limit'

const run = Date.now().toString(36)

/** Mimics an ioredis client whose every command fails (Redis down). */
function brokenRedis(): RateLimitStore {
  const fail = () => Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:6379'))
  const stub: Record<string, unknown> = {
    status: 'ready',
    defineCommand(name: string) {
      stub[name] = fail
    },
    multi() {
      throw new Error('connect ECONNREFUSED 127.0.0.1:6379')
    },
  }
  return stub as unknown as RateLimitStore
}

describe('createRateLimiter (Redis)', () => {
  afterAll(() => closeRateLimitStore())

  it('allows `points` requests, then blocks with a retry delay', async () => {
    const limiter = createRateLimiter(`test-${run}`, {
      points: 3,
      duration: 60,
      blockDuration: 120,
    })
    const key = `k-${run}`

    const first = await limiter.consume(key)
    expect(first).toMatchObject({ allowed: true, limit: 3, remaining: 2, degraded: false })
    await limiter.consume(key)
    const third = await limiter.consume(key)
    expect(third).toMatchObject({ allowed: true, remaining: 0 })

    const blocked = await limiter.consume(key)
    expect(blocked.allowed).toBe(false)
    expect(blocked.remaining).toBe(0)
    expect(blocked.retryAfterSeconds).toBeGreaterThan(60)
    expect(blocked.retryAfterSeconds).toBeLessThanOrEqual(120)

    // Other keys are unaffected.
    expect((await limiter.consume(`other-${run}`)).allowed).toBe(true)
  })

  it('degrades to allow when the store is unavailable', async () => {
    const limiter = createRateLimiter(
      `down-${run}`,
      { points: 1, duration: 60 },
      {
        client: brokenRedis(),
      },
    )
    for (let i = 0; i < 3; i += 1) {
      const decision = await limiter.consume('anyone')
      expect(decision.allowed).toBe(true)
      expect(decision.degraded).toBe(true)
    }
  })
})

describe('withRateLimit', () => {
  afterAll(() => closeRateLimitStore())

  const ok = async () => Response.json({ ok: true })

  it('returns 429 with Retry-After and X-RateLimit headers once the bucket is empty', async () => {
    const limiter = createRateLimiter(`route-${run}`, { points: 2, duration: 60 })
    const handler = withRateLimit(ok, limiter, { keyFrom: () => `ip:10.0.0.1-${run}` })
    const request = new Request('http://localhost/api/test')

    const first = await handler(request)
    expect(first.status).toBe(200)
    expect(first.headers.get('X-RateLimit-Limit')).toBe('2')
    expect(first.headers.get('X-RateLimit-Remaining')).toBe('1')

    await handler(request)
    const blocked = await handler(request)
    expect(blocked.status).toBe(429)
    expect(blocked.headers.get('X-RateLimit-Limit')).toBe('2')
    expect(blocked.headers.get('X-RateLimit-Remaining')).toBe('0')
    expect(Number(blocked.headers.get('Retry-After'))).toBeGreaterThan(0)
    await expect(blocked.json()).resolves.toMatchObject({
      errors: [{ message: expect.any(String) }],
    })
  })

  it('skips limiting when keyFrom returns null', async () => {
    const limiter = createRateLimiter(`skip-${run}`, { points: 1, duration: 60 })
    const handler = withRateLimit(ok, limiter, { keyFrom: () => null })
    for (let i = 0; i < 3; i += 1) {
      const res = await handler(new Request('http://localhost/api/test'))
      expect(res.status).toBe(200)
      expect(res.headers.has('X-RateLimit-Limit')).toBe(false)
    }
  })

  it('passes through responses untouched when the store is down', async () => {
    const limiter = createRateLimiter(
      `route-down-${run}`,
      { points: 1, duration: 60 },
      {
        client: brokenRedis(),
      },
    )
    const handler = withRateLimit(ok, limiter, { keyFrom: () => 'ip:1.1.1.1' })
    const res = await handler(new Request('http://localhost/api/test'))
    expect(res.status).toBe(200)
    expect(res.headers.has('X-RateLimit-Limit')).toBe(false)
  })
})

describe('clientIp', () => {
  const headers = (init: Record<string, string>) => ({ headers: new Headers(init) })

  it('ignores proxy headers unless trustProxy is on', () => {
    const request = headers({
      'x-forwarded-for': '203.0.113.9, 10.0.0.1',
      'x-real-ip': '198.51.100.2',
    })
    expect(clientIp(request, { trustProxy: false })).toBeNull()
    expect(clientIp(request, { trustProxy: true })).toBe('203.0.113.9')
  })

  it('falls back to X-Real-IP and rejects garbage', () => {
    expect(clientIp(headers({ 'x-real-ip': '2001:db8::1' }), { trustProxy: true })).toBe(
      '2001:db8::1',
    )
    expect(clientIp(headers({ 'x-forwarded-for': 'not an ip' }), { trustProxy: true })).toBeNull()
    expect(clientIp(headers({}), { trustProxy: true })).toBeNull()
  })
})
