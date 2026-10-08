import { getPayload } from 'payload'

import config from '@payload-config'
import { isMagicLinkEnabled, isSignupAllowed } from '@/server/settings'

export const dynamic = 'force-dynamic'

/** Public, non-sensitive auth configuration the login/signup UI needs. */
export async function GET() {
  const payload = await getPayload({ config })
  const [signupEnabled, magicLinkEnabled] = await Promise.all([
    isSignupAllowed(payload),
    isMagicLinkEnabled(payload),
  ])
  return Response.json({ signupEnabled, magicLinkEnabled })
}
