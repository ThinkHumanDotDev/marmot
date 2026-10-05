import { createRateLimiter, type RateLimiter } from './rate-limit'

/**
 * Process-wide limiters for Marmot's own route handlers. Payload's `login` / `forgot-password`
 * limiters live in `auth-hooks.ts` next to the hooks that use them.
 */
export const OIDC_RATE_LIMIT = { points: 20, duration: 60 }

/** `/api/auth/oidc/login` and `/callback` share one bucket per client IP. */
export const oidcLimiter: RateLimiter = createRateLimiter('oidc', OIDC_RATE_LIMIT)
