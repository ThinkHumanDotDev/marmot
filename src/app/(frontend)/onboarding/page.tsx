import type { Metadata } from 'next'
import Link from 'next/link'

import { Logo } from '@/components/logo'
import { CreateOrganizationForm } from '@/components/onboarding/create-organization-form'
import { Card, CardContent, CardDescription, CardHeader } from '@/components/ui/card'
import { getUserOrganizations, requireUser } from '@/lib/auth'

export const metadata: Metadata = { title: 'Create organization' }
export const dynamic = 'force-dynamic'

/**
 * First-run flow for users without an organization, also reachable from the organization
 * switcher ("New organization") for people who already belong to one.
 */
export default async function OnboardingPage() {
  const user = await requireUser('/onboarding')
  const organizations = await getUserOrganizations(user)
  const first = organizations.length === 0

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-6 bg-sidebar px-4 py-10">
      <Link href="/" aria-label="Marmot">
        <Logo />
      </Link>
      <Card className="w-full max-w-md">
        <CardHeader>
          <h1 data-slot="card-title" className="text-xl leading-none font-semibold">
            {first ? 'Create your organization' : 'New organization'}
          </h1>
          <CardDescription>
            {first
              ? 'Monitors, status pages and teammates live inside an organization. You can rename it later.'
              : 'Set up another workspace with its own monitors and members.'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <CreateOrganizationForm />
        </CardContent>
      </Card>
      <p className="text-xs text-muted-foreground">
        Signed in as {user.email}
        {!first && organizations[0] && (
          <>
            {' · '}
            <Link
              href={`/${organizations[0].slug}`}
              className="underline-offset-4 hover:text-foreground hover:underline"
            >
              Back to {organizations[0].name}
            </Link>
          </>
        )}
      </p>
    </main>
  )
}
