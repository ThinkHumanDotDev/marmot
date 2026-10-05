import { getPayload } from 'payload'

import config from '@payload-config'
import { handleOidcLogin } from '@/auth/oidc/handlers'
import { oidcLimiter } from '@/server/security/limiters'
import { withRateLimit } from '@/server/security/rate-limit'
import { ipKey } from '@/server/security/request'

export const dynamic = 'force-dynamic'

/**
 * GET /api/auth/oidc/login?next=/path — starts the OIDC authorization code flow (PKCE).
 * Rate limited per client IP (20/min, shared with the callback) when a trusted proxy address exists.
 */
export const GET = withRateLimit((request: Request) => handleOidcLogin(request), oidcLimiter, {
  keyFrom: ipKey(() => getPayload({ config })),
})
