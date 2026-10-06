import { getPayload } from 'payload'

import config from '@payload-config'
import { readJson, withErrors } from '@/server/http'
import { ssoLimiter } from '@/server/security/limiters'
import { withRateLimit } from '@/server/security/rate-limit'
import { ipKey } from '@/server/security/request'
import { lookupSsoForEmail, lookupSsoForOrg } from '@/server/sso/domains'

export const dynamic = 'force-dynamic'

/**
 * POST /api/auth/sso/lookup `{ email }` or `{ organization }` → `{ options: [...] }`
 *
 * Where the "Sign in with SSO" page sends people: the enabled connections of the organization that
 * verified the email's domain, or of the organization with that slug. Public, so it only returns
 * names and login paths; an unknown domain or slug yields an empty list rather than an error.
 */
export const POST = withRateLimit(
  withErrors(async (request: Request) => {
    const payload = await getPayload({ config })
    const body = await readJson<{ email?: unknown; organization?: unknown }>(request)
    const email = typeof body.email === 'string' ? body.email.trim() : ''
    const organization = typeof body.organization === 'string' ? body.organization.trim() : ''
    const options = email
      ? await lookupSsoForEmail(payload, email)
      : organization
        ? await lookupSsoForOrg(payload, organization)
        : []
    return Response.json({ options }, { headers: { 'Cache-Control': 'no-store' } })
  }),
  ssoLimiter,
  { keyFrom: ipKey(() => getPayload({ config })) },
)
