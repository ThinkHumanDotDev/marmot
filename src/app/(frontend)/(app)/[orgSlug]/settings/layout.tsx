import React from 'react'

import { can } from '@/access/permissions'
import { PageHeader } from '@/components/page-header'
import { SettingsTabs } from '@/components/settings/settings-tabs'
import { getCurrentUser } from '@/lib/auth'
import { getOrgBySlug } from '@/lib/org'
import { isBillingEnabled } from '@/server/billing/entitlements'

interface SettingsLayoutProps {
  children: React.ReactNode
  params: Promise<{ orgSlug: string }>
}

/** Whether the viewer may see the Billing tab: billing on and `organization:update` (admin+). */
async function canSeeBilling(orgSlug: string): Promise<boolean> {
  if (!isBillingEnabled()) return false
  const user = await getCurrentUser()
  if (!user) return false
  const org = await getOrgBySlug(user, orgSlug)
  return org ? can(user, org.id, 'organization:update') : false
}

/** Settings frame: header + tab strip (Account · Organization · Members · Tags · Proxies · Docker hosts · Import / Export · Billing). */
export default async function SettingsLayout({ children, params }: SettingsLayoutProps) {
  const { orgSlug } = await params
  const showBilling = await canSeeBilling(orgSlug)
  return (
    <>
      <PageHeader
        title="Settings"
        description="Your account, this organization, who has access and shared monitor resources."
        className="border-b-0 pb-2"
      />
      <div className="border-b px-4 sm:px-6 md:px-8">
        <SettingsTabs orgSlug={orgSlug} showBilling={showBilling} />
      </div>
      <section className="mx-auto flex w-full max-w-3xl flex-col gap-8 p-4 sm:p-6 md:p-8">
        {children}
      </section>
    </>
  )
}
