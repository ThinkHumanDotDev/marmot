import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { getPayload } from 'payload'
import { Suspense } from 'react'

import config from '@payload-config'
import { can } from '@/access/permissions'
import { BillingPanel } from '@/components/settings/billing-panel'
import { requireUser } from '@/lib/auth'
import { getOrgBySlug } from '@/lib/org'
import { isBillingEnabled } from '@/server/billing/entitlements'
import { getBillingOverview } from '@/server/billing/overview'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('settings.pageTitles')
  return { title: t('billing') }
}
export const dynamic = 'force-dynamic'

/**
 * `/[orgSlug]/settings/billing` — plan, usage and Stripe actions. 404 while `BILLING_ENABLED` is
 * off (self-host) and for members below admin, mirroring the tab's visibility.
 */
export default async function BillingSettingsPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>
}) {
  const { orgSlug } = await params
  if (!isBillingEnabled()) notFound()
  const user = await requireUser(`/${orgSlug}/settings/billing`)
  const org = await getOrgBySlug(user, orgSlug)
  if (!org || !can(user, org.id, 'organization:update')) notFound()

  const payload = await getPayload({ config })
  const overview = await getBillingOverview(payload, org)

  return (
    <Suspense>
      <BillingPanel orgId={org.id} overview={overview} />
    </Suspense>
  )
}
