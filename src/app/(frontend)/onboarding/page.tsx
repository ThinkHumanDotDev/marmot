import type { Metadata } from 'next'
import Link from 'next/link'
import { getTranslations } from 'next-intl/server'

import { Logo } from '@/components/logo'
import { CreateOrganizationForm } from '@/components/onboarding/create-organization-form'
import { Card, CardContent, CardDescription, CardHeader } from '@/components/ui/card'
import { getUserOrganizations, requireUser } from '@/lib/auth'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('onboarding')
  return { title: t('pageTitle') }
}

export const dynamic = 'force-dynamic'

/**
 * First-run flow for users without an organization, also reachable from the organization
 * switcher ("New organization") for people who already belong to one.
 */
export default async function OnboardingPage() {
  const user = await requireUser('/onboarding')
  const organizations = await getUserOrganizations(user)
  const first = organizations.length === 0
  const t = await getTranslations('onboarding')
  const tc = await getTranslations('common')

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-6 bg-sidebar px-4 py-10">
      <Link href="/" aria-label={tc('appName')}>
        <Logo />
      </Link>
      <Card className="w-full max-w-md">
        <CardHeader>
          <h1 data-slot="card-title" className="text-xl leading-none font-semibold">
            {first ? t('firstTitle') : t('title')}
          </h1>
          <CardDescription>{first ? t('firstDescription') : t('description')}</CardDescription>
        </CardHeader>
        <CardContent>
          <CreateOrganizationForm />
        </CardContent>
      </Card>
      <p className="text-xs text-muted-foreground">
        {t('signedInAs', { email: user.email })}
        {!first && organizations[0] && (
          <>
            {' · '}
            <Link
              href={`/${organizations[0].slug}`}
              className="underline-offset-4 hover:text-foreground hover:underline"
            >
              {t('backTo', { organization: organizations[0].name })}
            </Link>
          </>
        )}
      </p>
    </main>
  )
}
