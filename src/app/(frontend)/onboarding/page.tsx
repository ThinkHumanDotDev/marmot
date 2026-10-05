import { Building2 } from 'lucide-react'
import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'

import { EmptyState } from '@/components/empty-state'
import { Logo } from '@/components/logo'
import { Button } from '@/components/ui/button'
import { getUserOrganizations, requireUser } from '@/lib/auth'

export const metadata: Metadata = { title: 'Get started' }
export const dynamic = 'force-dynamic'

/**
 * Placeholder landing for users without an organization. The members issue replaces this with
 * the real "create your organization" flow.
 */
export default async function OnboardingPage() {
  const user = await requireUser('/onboarding')
  const organizations = await getUserOrganizations(user)
  if (organizations.length > 0) redirect(`/${organizations[0].slug}`)

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-8 bg-sidebar px-4 py-10">
      <Logo />
      <EmptyState
        icon={Building2}
        title="You need an organization"
        description="Monitors, status pages and notifications live inside an organization. Ask an owner to invite you, or create one once organizations are available."
        className="bg-background"
        action={
          <Button asChild variant="outline">
            <Link href="/admin">Open admin panel</Link>
          </Button>
        }
      />
      <p className="text-xs text-muted-foreground">Signed in as {user.email}</p>
    </main>
  )
}
