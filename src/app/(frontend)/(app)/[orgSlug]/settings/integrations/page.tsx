import { Siren } from 'lucide-react'
import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'

import { EmptyState } from '@/components/empty-state'
import { IntegrationsView } from '@/components/settings/integrations-view'
import { SlackAppCard } from '@/components/settings/slack-app-card'
import { listIntegrations } from '@/server/integrations/manage'
import { integrationChoices } from '@/server/integrations/page-data'
import { getOrgPageContext } from '@/server/monitors/page-data'
import { isPushEmailEnabled } from '@/server/push/inbound-config'
import { slackSettings } from '@/server/slack/manage'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('settings.pageTitles')
  return { title: t('integrations') }
}
export const dynamic = 'force-dynamic'

/**
 * Settings → Integrations: the Slack app (#129, when configured) and the inbound alert
 * integrations of the organization (#152). Needs `integration:read` (members by default); changes
 * need `integration:manage` (admins).
 */
export default async function IntegrationsSettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string }>
  searchParams: Promise<{ slack?: string }>
}) {
  const { orgSlug } = await params
  const { slack: slackOutcome } = await searchParams
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
  const [integrations, choices, slack] = await Promise.all([
    listIntegrations(orgCtx),
    integrationChoices(ctx),
    slackSettings(ctx.payload, ctx.org.id),
  ])
  return (
    <div className="flex flex-col gap-6">
      {slack.enabled && (
        <SlackAppCard
          orgId={String(ctx.org.id)}
          initial={slack.installation}
          canManage={ctx.allowed('integration:manage')}
          outcome={typeof slackOutcome === 'string' ? slackOutcome.slice(0, 40) : undefined}
        />
      )}
      <IntegrationsView
        orgId={String(ctx.org.id)}
        initial={integrations}
        choices={choices}
        emailEnabled={isPushEmailEnabled()}
        canManage={ctx.allowed('integration:manage')}
      />
    </div>
  )
}
