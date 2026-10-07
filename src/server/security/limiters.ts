import { env } from '@/env'

import { createRateLimiter, type RateLimiter } from './rate-limit'

/**
 * Process-wide limiters for Marmot's own route handlers. Payload's `login` / `forgot-password`
 * limiters live in `auth-hooks.ts` next to the hooks that use them.
 */
export const SSO_RATE_LIMIT = { points: 20, duration: 60 }

/** The single sign-on login and callback routes (`/api/auth/{oidc,sso}`) share one bucket per client IP. */
export const ssoLimiter: RateLimiter = createRateLimiter('sso', SSO_RATE_LIMIT)

/** On-demand checks ("Check now", ad-hoc tests): one bucket per organization. */
export const onDemandCheckLimiter: RateLimiter = createRateLimiter('on-demand-checks', {
  points: env.ON_DEMAND_CHECKS_PER_MINUTE,
  duration: 60,
})

/**
 * Management API requests per organization API key (`API_KEY_RATE_LIMIT` per minute), keyed by the
 * key's id. `null` when the limit is turned off (`0`).
 */
export const apiKeyLimiter: RateLimiter | null =
  env.API_KEY_RATE_LIMIT > 0
    ? createRateLimiter('api-key', { points: env.API_KEY_RATE_LIMIT, duration: 60 })
    : null

/** Mutations per API key (`API_KEY_WRITE_RATE_LIMIT` per minute), on top of `apiKeyLimiter`. */
export const apiKeyWriteLimiter: RateLimiter | null =
  env.API_KEY_WRITE_RATE_LIMIT > 0
    ? createRateLimiter('api-key-write', { points: env.API_KEY_WRITE_RATE_LIMIT, duration: 60 })
    : null
