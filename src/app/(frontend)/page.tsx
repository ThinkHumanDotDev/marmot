import { redirect } from 'next/navigation'
import { getPayload } from 'payload'

import config from '@payload-config'
import { LandingPage } from '@/components/landing/landing-page'
import { env } from '@/env'
import { getCurrentUser, getUserOrganizations, homePathFor } from '@/lib/auth'
import { resolveHomeRoute } from '@/server/home'
import { isSignupAllowed } from '@/server/settings'
import { needsSetup } from '@/server/setup'

export const dynamic = 'force-dynamic'

/**
 * `/` is a router: fresh install → setup wizard, signed-out → login (or the landing page when
 * `LANDING_PAGE_ENABLED` is on), signed-in → first organization (or onboarding).
 */
export default async function HomePage() {
  const user = await getCurrentUser()
  const payload = await getPayload({ config })
  const route = resolveHomeRoute({
    userHome: user ? homePathFor(await getUserOrganizations(user)) : null,
    setupNeeded: !user && (await needsSetup(payload)),
    landingEnabled: env.LANDING_PAGE_ENABLED,
  })
  if (route.kind === 'redirect') redirect(route.to)
  return <LandingPage signupEnabled={await isSignupAllowed(payload)} />
}
