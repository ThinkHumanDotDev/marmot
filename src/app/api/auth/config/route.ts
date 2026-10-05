import { env } from '@/env'

export const dynamic = 'force-dynamic'

/** Public, non-sensitive auth configuration the login/signup UI needs. */
export async function GET() {
  return Response.json({ signupEnabled: !env.DISABLE_SIGNUP })
}
