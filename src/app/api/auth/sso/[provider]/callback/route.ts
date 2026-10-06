import { getPayload } from 'payload'

import config from '@payload-config'
import { handleSsoCallback } from '@/auth/sso/handlers'
import { ssoLimiter } from '@/server/security/limiters'
import { withRateLimit } from '@/server/security/rate-limit'
import { ipKey } from '@/server/security/request'

export const dynamic = 'force-dynamic'

type Context = { params: Promise<{ provider: string }> }

/**
 * GET /api/auth/sso/:provider/callback — redirect URI to register at the provider. Rate limited per
 * client IP (20/min, shared with `/login`) when a trusted proxy address exists.
 */
export const GET = withRateLimit(
  async (request: Request, { params }: Context) =>
    handleSsoCallback(request, (await params).provider),
  ssoLimiter,
  { keyFrom: ipKey(() => getPayload({ config })) },
)
