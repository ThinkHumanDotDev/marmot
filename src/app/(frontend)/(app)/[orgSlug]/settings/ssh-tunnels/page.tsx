import { Cable } from 'lucide-react'
import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'

import { EmptyState } from '@/components/empty-state'
import { toSshTunnelRow } from '@/components/settings/resources-api'
import { SshTunnelsSettings } from '@/components/settings/ssh-tunnels-settings'
import { getOrgPageContext } from '@/server/monitors/page-data'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('settings.pageTitles')
  return { title: t('sshTunnels') }
}
export const dynamic = 'force-dynamic'

export default async function SshTunnelsSettingsPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>
}) {
  const { orgSlug } = await params
  const ctx = await getOrgPageContext(orgSlug, `/${orgSlug}/settings/ssh-tunnels`)
  if (!ctx.allowed('ssh-tunnel:read')) {
    const t = await getTranslations('settings.sshTunnels')
    return (
      <EmptyState
        icon={Cable}
        title={t('membersOnlyTitle')}
        description={t('membersOnlyDescription')}
      />
    )
  }

  // Credentials are write-only (field access): the rows only say whether they are set.
  const { docs } = await ctx.payload.find({
    collection: 'ssh-tunnels',
    where: { organization: { equals: ctx.org.id } },
    sort: 'name',
    depth: 0,
    limit: 200,
    user: ctx.requestUser,
    overrideAccess: false,
  })

  return (
    <SshTunnelsSettings
      orgId={String(ctx.org.id)}
      initial={docs.map((doc) => toSshTunnelRow(doc))}
      canManage={ctx.allowed('ssh-tunnel:update')}
    />
  )
}
