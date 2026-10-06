import { Network } from 'lucide-react'
import type { Metadata } from 'next'

import { EmptyState } from '@/components/empty-state'
import { ProxiesSettings } from '@/components/settings/proxies-settings'
import { toProxyRow } from '@/components/settings/resources-api'
import { getOrgPageContext } from '@/server/monitors/page-data'

export const metadata: Metadata = { title: 'Proxies' }
export const dynamic = 'force-dynamic'

export default async function ProxiesSettingsPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>
}) {
  const { orgSlug } = await params
  const ctx = await getOrgPageContext(orgSlug, `/${orgSlug}/settings/proxies`)
  if (!ctx.allowed('proxy:read')) {
    return (
      <EmptyState
        icon={Network}
        title="Members only"
        description="Proxies are visible to members and managed by admins of this organization."
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
