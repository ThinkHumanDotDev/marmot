import { Siren } from 'lucide-react'
import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'

import { EmptyState } from '@/components/empty-state'
import { IntegrationsView } from '@/components/settings/integrations-view'
import { listIntegrations } from '@/server/integrations/manage'
import { integrationChoices } from '@/server/integrations/page-data'
import { getOrgPageContext } from '@/server/monitors/page-data'
import { isPushEmailEnabled } from '@/server/push/inbound-config'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('settings.pageTitles')
  return { title: t('integrations') }
}
export const dynamic = 'force-dynamic'

/**
 * Settings → Integrations: inbound alert integrations of the organization (#152). Needs
 * `integration:read` (members by default); changes need `integration:manage` (admins).
 */
export default async function IntegrationsSettingsPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>
}) {
  const { orgSlug } = await params
  const ctx = await getOrgPageContext(orgSlug, `/${orgSlug}/settings/integrations`)
  if (!ctx.allowed('integration:read')) {
    const t = await getTranslations('settings.integrations')
    return (
      <EmptyState
        icon={Siren}
        title={t('forbiddenTitle')}
        description={t('forbiddenDescription')}
      />
    )
  }

  const orgCtx = { payload: ctx.payload, user: ctx.requestUser, orgId: ctx.org.id }
  const [integrations, choices] = await Promise.all([
    listIntegrations(orgCtx),
    integrationChoices(ctx),
  ])
  return (
    <IntegrationsView
      orgId={String(ctx.org.id)}
      initial={integrations}
      choices={choices}
      emailEnabled={isPushEmailEnabled()}
      canManage={ctx.allowed('integration:manage')}
    />
  )
}
