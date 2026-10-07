import { Network } from 'lucide-react'
import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'

import { EmptyState } from '@/components/empty-state'
import { ProxiesSettings } from '@/components/settings/proxies-settings'
import { toProxyRow } from '@/components/settings/resources-api'
import { getOrgPageContext } from '@/server/monitors/page-data'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('settings.pageTitles')
  return { title: t('proxies') }
}
export const dynamic = 'force-dynamic'

export default async function ProxiesSettingsPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>
}) {
  const { orgSlug } = await params
  const ctx = await getOrgPageContext(orgSlug, `/${orgSlug}/settings/proxies`)
  if (!ctx.allowed('proxy:read')) {
    const t = await getTranslations('settings.proxies')
    return (
      <EmptyState
        icon={Network}
        title={t('membersOnlyTitle')}
        description={t('membersOnlyDescription')}
      />
    )
  }

  // Field-level access strips passwords for users who may not edit proxies.
  const { docs } = await ctx.payload.find({
    collection: 'proxies',
    where: { organization: { equals: ctx.org.id } },
    depth: 0,
    limit: 200,
    user: ctx.requestUser,
    overrideAccess: false,
  })

  return (
    <ProxiesSettings
      orgId={String(ctx.org.id)}
      initial={docs.map((doc) => toProxyRow(doc))}
      canManage={ctx.allowed('proxy:update')}
    />
  )
}
