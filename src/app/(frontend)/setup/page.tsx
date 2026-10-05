import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { getPayload } from 'payload'

import config from '@payload-config'
import { AuthCard } from '@/components/auth/auth-card'
import { SetupForm } from '@/components/auth/setup-form'
import { needsSetup } from '@/server/setup'

export const metadata: Metadata = { title: 'Set up Marmot' }
export const dynamic = 'force-dynamic'

/**
 * First-run wizard. Only reachable while no user exists; afterwards it sends visitors to the
 * login page (which in turn forwards signed-in users to their organization).
 */
export default async function SetupPage() {
  const payload = await getPayload({ config })
  if (!(await needsSetup(payload))) redirect('/login')

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center bg-sidebar px-4 py-10 text-foreground">
      <AuthCard
        title="Welcome to Marmot"
        description="Create the administrator account and your first organization to finish installing."
      >
        <SetupForm />
      </AuthCard>
      <p className="mt-10 text-xs text-muted-foreground">Marmot · self-hosted status monitoring</p>
    </main>
  )
}
