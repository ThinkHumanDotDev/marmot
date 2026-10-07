import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'

import { TagsSettings } from '@/components/settings/tags-settings'
import { toTagRow } from '@/components/settings/resources-api'
import { getOrgPageContext } from '@/server/monitors/page-data'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('settings.pageTitles')
  return { title: t('tags') }
}
export const dynamic = 'force-dynamic'

export default async function TagsSettingsPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>
}) {
  const { orgSlug } = await params
  const ctx = await getOrgPageContext(orgSlug, `/${orgSlug}/settings/tags`)
  const { docs } = await ctx.payload.find({
    collection: 'tags',
    where: { organization: { equals: ctx.org.id } },
    sort: 'name',
    depth: 0,
    limit: 500,
    user: ctx.requestUser,
    overrideAccess: false,
  })

  return (
    <TagsSettings
      orgId={String(ctx.org.id)}
      initial={docs.map((doc) => toTagRow(doc))}
      canManage={ctx.allowed('tag:update')}
    />
  )
}
