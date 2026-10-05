import { getPayload } from 'payload'

import config from '@payload-config'
import { handleOidcCallback } from '@/auth/oidc/handlers'
import { oidcLimiter } from '@/server/security/limiters'
import { withRateLimit } from '@/server/security/rate-limit'
import { ipKey } from '@/server/security/request'

export const dynamic = 'force-dynamic'

/**
 * GET /api/auth/oidc/callback — redirect URI registered at the identity provider.
 * Rate limited per client IP (20/min, shared with `/login`) when a trusted proxy address exists.
 */
export const GET = withRateLimit((request: Request) => handleOidcCallback(request), oidcLimiter, {
  keyFrom: ipKey(() => getPayload({ config })),
})
