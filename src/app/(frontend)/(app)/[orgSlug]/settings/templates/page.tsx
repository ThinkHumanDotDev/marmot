import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'

import { TemplatesSettings } from '@/components/settings/templates-settings'
import { getOrgPageContext } from '@/server/monitors/page-data'
import { getOrgTemplates, getTemplatePageOptions } from '@/server/templates/page-data'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('settings.pageTitles')
  return { title: t('templates') }
}
export const dynamic = 'force-dynamic'

export default async function TemplatesSettingsPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>
}) {
  const { orgSlug } = await params
  const ctx = await getOrgPageContext(orgSlug, `/${orgSlug}/settings/templates`)
  const [templates, pages] = await Promise.all([getOrgTemplates(ctx), getTemplatePageOptions(ctx)])

  return (
    <TemplatesSettings
      orgId={String(ctx.org.id)}
      initial={templates}
      pages={pages}
      canManage={ctx.allowed('template:update')}
    />
  )
}
