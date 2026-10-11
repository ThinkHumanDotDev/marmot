import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { getPayload } from 'payload'

import { AuthCard } from '@/components/auth/auth-card'
import { SignupForm } from '@/components/auth/signup-form'
import { LegalNotice } from '@/components/legal-links'
import config from '@payload-config'
import { getCurrentUser } from '@/lib/auth'
import { safeNextPath } from '@/lib/utils'
import { isSignupAllowed } from '@/server/settings'
import { getSiteLinks } from '@/server/site-links'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('auth.signup')
  return { title: t('pageTitle') }
}
export const dynamic = 'force-dynamic'

export default async function SignupPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>
}) {
  const { next } = await searchParams
  if (!(await isSignupAllowed(await getPayload({ config })))) notFound()
  const user = await getCurrentUser()
  if (user) redirect(safeNextPath(next))
  const t = await getTranslations('auth.signup')
  const { termsUrl, privacyUrl } = getSiteLinks()

  return (
    <AuthCard
      title={t('title')}
      description={t('description')}
      footer={t.rich('haveAccount', {
        link: (chunks) => (
          <Link
            href={next ? `/login?next=${encodeURIComponent(next)}` : '/login'}
            className="font-medium text-foreground underline-offset-4 hover:underline"
          >
            {chunks}
          </Link>
        ),
      })}
    >
      <SignupForm next={next} />
      <LegalNotice
        termsUrl={termsUrl}
        privacyUrl={privacyUrl}
        context="signup"
        className="mt-4 text-center"
      />
    </AuthCard>
  )
}
