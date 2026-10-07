import { Container } from 'lucide-react'
import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'

import { EmptyState } from '@/components/empty-state'
import { DockerHostsSettings } from '@/components/settings/docker-hosts-settings'
import { toDockerHostRow } from '@/components/settings/resources-api'
import { getOrgPageContext } from '@/server/monitors/page-data'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('settings.pageTitles')
  return { title: t('dockerHosts') }
}
export const dynamic = 'force-dynamic'

export default async function DockerHostsSettingsPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>
}) {
  const { orgSlug } = await params
  const ctx = await getOrgPageContext(orgSlug, `/${orgSlug}/settings/docker-hosts`)
  if (!ctx.allowed('docker-host:read')) {
    const t = await getTranslations('settings.dockerHosts')
    return (
      <EmptyState
        icon={Container}
        title={t('membersOnlyTitle')}
        description={t('membersOnlyDescription')}
      />
    )
  }

  const { docs } = await ctx.payload.find({
    collection: 'docker-hosts',
    where: { organization: { equals: ctx.org.id } },
    sort: 'name',
    depth: 0,
    limit: 200,
    user: ctx.requestUser,
    overrideAccess: false,
  })

  return (
    <DockerHostsSettings
      orgId={String(ctx.org.id)}
      initial={docs.map((doc) => toDockerHostRow(doc))}
      canManage={ctx.allowed('docker-host:update')}
    />
  )
}
