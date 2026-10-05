import { redirect } from 'next/navigation'
import { getPayload } from 'payload'

import config from '@payload-config'
import { getCurrentUser, getUserOrganizations, homePathFor } from '@/lib/auth'
import { needsSetup } from '@/server/setup'

export const dynamic = 'force-dynamic'

/**
 * `/` is a router: fresh install → setup wizard, signed-out → login, signed-in → first
 * organization (or onboarding).
 */
export default async function HomePage() {
  const user = await getCurrentUser()
  if (!user) {
    const payload = await getPayload({ config })
    if (await needsSetup(payload)) redirect('/setup')
    redirect('/login')
  }
  redirect(homePathFor(await getUserOrganizations(user)))
}
