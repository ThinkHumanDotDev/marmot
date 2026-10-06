import { getPayload } from 'payload'

import config from '@payload-config'
import { handleSamlAcs } from '@/auth/sso/handlers'
import { ssoLimiter } from '@/server/security/limiters'
import { withRateLimit } from '@/server/security/rate-limit'
import { ipKey } from '@/server/security/request'

export const dynamic = 'force-dynamic'

type Context = { params: Promise<{ connection: string }> }

/**
 * POST /api/auth/saml/:connection/acs — assertion consumer service registered at the IdP. Rate
 * limited per client IP (20/min, shared with the other SSO routes) when a trusted proxy exists.
 */
export const POST = withRateLimit(
  async (request: Request, { params }: Context) =>
    handleSamlAcs(request, (await params).connection),
  ssoLimiter,
  { keyFrom: ipKey(() => getPayload({ config })) },
)
