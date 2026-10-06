import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { getPayload } from 'payload'

import config from '@payload-config'
import { AuthCard } from '@/components/auth/auth-card'
import { SetupForm } from '@/components/auth/setup-form'
import { needsSetup } from '@/server/setup'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('auth.setup')
  return { title: t('pageTitle') }
}
export const dynamic = 'force-dynamic'

/**
 * First-run wizard. Only reachable while no user exists; afterwards it sends visitors to the
 * login page (which in turn forwards signed-in users to their organization).
 */
export default async function SetupPage() {
  const payload = await getPayload({ config })
  if (!(await needsSetup(payload))) redirect('/login')
  const [t, tc] = await Promise.all([getTranslations('auth.setup'), getTranslations('common')])

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center bg-sidebar px-4 py-10 text-foreground">
      <AuthCard title={t('title')} description={t('description')}>
        <SetupForm />
      </AuthCard>
      <p className="mt-10 text-xs text-muted-foreground">{tc('tagline')}</p>
    </main>
  )
}
