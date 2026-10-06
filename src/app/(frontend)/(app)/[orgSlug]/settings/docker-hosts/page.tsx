import { Container } from 'lucide-react'
import type { Metadata } from 'next'

import { EmptyState } from '@/components/empty-state'
import { DockerHostsSettings } from '@/components/settings/docker-hosts-settings'
import { toDockerHostRow } from '@/components/settings/resources-api'
import { getOrgPageContext } from '@/server/monitors/page-data'

export const metadata: Metadata = { title: 'Docker hosts' }
export const dynamic = 'force-dynamic'

export default async function DockerHostsSettingsPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>
}) {
  const { orgSlug } = await params
  const ctx = await getOrgPageContext(orgSlug, `/${orgSlug}/settings/docker-hosts`)
  if (!ctx.allowed('docker-host:read')) {
    return (
      <EmptyState
        icon={Container}
        title="Members only"
        description="Docker hosts are visible to members and managed by admins of this organization."
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
