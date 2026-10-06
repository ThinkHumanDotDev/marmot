import { getPayload } from 'payload'

import config from '@payload-config'
import { handleSamlLogin } from '@/auth/sso/handlers'
import { ssoLimiter } from '@/server/security/limiters'
import { withRateLimit } from '@/server/security/rate-limit'
import { ipKey } from '@/server/security/request'

export const dynamic = 'force-dynamic'

type Context = { params: Promise<{ connection: string }> }

/**
 * GET /api/auth/saml/:connection/login?next=/path — starts SP-initiated SAML login at the
 * organization connection with that slug. Rate limited per client IP (20/min, shared with the
 * other SSO routes) when a trusted proxy address exists.
 */
export const GET = withRateLimit(
  async (request: Request, { params }: Context) =>
    handleSamlLogin(request, (await params).connection),
  ssoLimiter,
  { keyFrom: ipKey(() => getPayload({ config })) },
)
