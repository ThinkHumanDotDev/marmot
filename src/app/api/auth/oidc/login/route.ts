import { getPayload } from 'payload'

import config from '@payload-config'
import { handleSsoLogin } from '@/auth/sso/handlers'
import { OIDC_PROVIDER_ID } from '@/auth/sso/providers'
import { ssoLimiter } from '@/server/security/limiters'
import { withRateLimit } from '@/server/security/rate-limit'
import { ipKey } from '@/server/security/request'

export const dynamic = 'force-dynamic'

/**
 * GET /api/auth/oidc/login?next=/path — starts the authorization code flow (PKCE) at the
 * env-configured OIDC provider. Same as `/api/auth/sso/oidc/login`; kept for existing links.
 * Rate limited per client IP (20/min, shared with the callback) when a trusted proxy address exists.
 */
export const GET = withRateLimit(
  (request: Request) => handleSsoLogin(request, OIDC_PROVIDER_ID),
  ssoLimiter,
  { keyFrom: ipKey(() => getPayload({ config })) },
)
