import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { getPayload } from 'payload'

import { AuthCard } from '@/components/auth/auth-card'
import { SsoLookupForm } from '@/components/auth/sso-lookup-form'
import config from '@payload-config'
import { getCurrentUser } from '@/lib/auth'
import { safeNextPath } from '@/lib/utils'
import { lookupSsoForOrg } from '@/server/sso/domains'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('auth.ssoLookup')
  return { title: t('pageTitle') }
}
export const dynamic = 'force-dynamic'

/**
 * `/login/sso[?org=<slug>]`: routes people to their organization's identity provider by work email
 * or organization slug (`POST /api/auth/sso/lookup`). With `?org=` the organization's connections
 * are offered straight away, which gives each organization a shareable sign-in link.
 */
export default async function SsoLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; org?: string }>
}) {
  const { next, org } = await searchParams
  const user = await getCurrentUser()
  if (user) redirect(safeNextPath(next))

  const safeNext = next ? safeNextPath(next) : undefined
  const initialOptions = org ? await lookupSsoForOrg(await getPayload({ config }), org) : undefined
  if (initialOptions?.length === 1) {
    const [only] = initialOptions
    redirect(safeNext ? `${only.loginPath}?next=${encodeURIComponent(safeNext)}` : only.loginPath)
  }

  const t = await getTranslations('auth.ssoLookup')
  return (
    <AuthCard
      title={t('title')}
      description={t('description')}
      footer={
        <Link
          href={safeNext ? `/login?next=${encodeURIComponent(safeNext)}` : '/login'}
          className="font-medium text-foreground underline-offset-4 hover:underline"
        >
          {t('backToSignIn')}
        </Link>
      }
    >
      <SsoLookupForm next={safeNext} initialOptions={initialOptions} initialOrganization={org} />
    </AuthCard>
  )
}
