import { getPayload } from 'payload'

import config from '@payload-config'
import { handleSsoCallback } from '@/auth/sso/handlers'
import { OIDC_PROVIDER_ID } from '@/auth/sso/providers'
import { ssoLimiter } from '@/server/security/limiters'
import { withRateLimit } from '@/server/security/rate-limit'
import { ipKey } from '@/server/security/request'

export const dynamic = 'force-dynamic'

/**
 * GET /api/auth/oidc/callback — the redirect URI registered at the env-configured OIDC provider
 * (unchanged since before single sign-on moved to the payload-auth plugin, so registrations keep
 * working). Rate limited per client IP (20/min, shared with `/login`).
 */
export const GET = withRateLimit(
  (request: Request) => handleSsoCallback(request, OIDC_PROVIDER_ID),
  ssoLimiter,
  { keyFrom: ipKey(() => getPayload({ config })) },
)
