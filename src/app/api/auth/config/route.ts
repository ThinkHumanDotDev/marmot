import { getPayload } from 'payload'

import config from '@payload-config'
import { isSignupAllowed } from '@/server/settings'

export const dynamic = 'force-dynamic'

/** Public, non-sensitive auth configuration the login/signup UI needs. */
export async function GET() {
  const payload = await getPayload({ config })
  return Response.json({ signupEnabled: await isSignupAllowed(payload) })
}
