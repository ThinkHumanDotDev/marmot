import { getPayload } from 'payload'

import config from '@payload-config'
import { handleSsoLogin } from '@/auth/sso/handlers'
import { ssoLimiter } from '@/server/security/limiters'
import { withRateLimit } from '@/server/security/rate-limit'
import { ipKey } from '@/server/security/request'

export const dynamic = 'force-dynamic'

type Context = { params: Promise<{ provider: string }> }

/**
 * GET /api/auth/sso/:provider/login?next=/path — starts the OAuth 2.0 / OpenID Connect flow at the
 * named provider (`GET /api/auth/providers` lists them). Add `link=1` while signed in to attach the
 * identity to the current account instead of signing in. Rate limited per client IP (20/min, shared
 * with the callback) when a trusted proxy address exists.
 */
export const GET = withRateLimit(
  async (request: Request, { params }: Context) => handleSsoLogin(request, (await params).provider),
  ssoLimiter,
  { keyFrom: ipKey(() => getPayload({ config })) },
)
