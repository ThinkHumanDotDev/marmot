import { redirect } from 'next/navigation'

import { getCurrentUser, getUserOrganizations, homePathFor } from '@/lib/auth'

export const dynamic = 'force-dynamic'

/** `/` is a router: signed-out → login, signed-in → first organization (or onboarding). */
export default async function HomePage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  redirect(homePathFor(await getUserOrganizations(user)))
}
