import { createRateLimiter, type RateLimiter } from './rate-limit'

/**
 * Process-wide limiters for Marmot's own route handlers. Payload's `login` / `forgot-password`
 * limiters live in `auth-hooks.ts` next to the hooks that use them.
 */
export const SSO_RATE_LIMIT = { points: 20, duration: 60 }

/** The single sign-on login and callback routes (`/api/auth/{oidc,sso}`) share one bucket per client IP. */
export const ssoLimiter: RateLimiter = createRateLimiter('sso', SSO_RATE_LIMIT)
