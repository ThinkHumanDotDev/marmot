import React from 'react'

import { PageHeader } from '@/components/page-header'
import { SettingsTabs } from '@/components/settings/settings-tabs'

interface SettingsLayoutProps {
  children: React.ReactNode
  params: Promise<{ orgSlug: string }>
}

/** Settings frame: header + tab strip (Account · Organization · Members · Tags · Proxies · Docker hosts). */
export default async function SettingsLayout({ children, params }: SettingsLayoutProps) {
  const { orgSlug } = await params
  return (
    <>
      <PageHeader
        title="Settings"
        description="Your account, this organization, who has access and shared monitor resources."
        className="border-b-0 pb-2"
      />
      <div className="border-b px-6 md:px-8">
        <SettingsTabs orgSlug={orgSlug} />
      </div>
      <section className="mx-auto flex w-full max-w-3xl flex-col gap-8 p-6 md:p-8">
        {children}
      </section>
    </>
  )
}
