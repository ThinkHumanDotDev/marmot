import { Webhook } from 'lucide-react'
import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'

import { EmptyState } from '@/components/empty-state'
import { WebhooksView } from '@/components/settings/webhooks-view'
import { WEBHOOK_EVENT_GROUPS } from '@/lib/webhook-events'
import { getOrgPageContext } from '@/server/monitors/page-data'
import { listEndpoints } from '@/server/webhooks/manage'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('settings.pageTitles')
  return { title: t('webhooks') }
}
export const dynamic = 'force-dynamic'

/**
 * Settings → Webhooks: outbound event webhooks of the organization (#157). Needs `webhook:read`
 * (owners and admins by default; permission overrides apply); changes need `webhook:manage`.
 */
export default async function WebhooksSettingsPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>
}) {
  const { orgSlug } = await params
  const ctx = await getOrgPageContext(orgSlug, `/${orgSlug}/settings/webhooks`)
  if (!ctx.allowed('webhook:read')) {
    const t = await getTranslations('settings.webhooks')
    return (
      <EmptyState
        icon={Webhook}
        title={t('adminsOnlyTitle')}
        description={t('adminsOnlyDescription')}
      />
    )
  }

  const endpoints = await listEndpoints({
    payload: ctx.payload,
    user: ctx.requestUser,
    orgId: ctx.org.id,
  })
  return (
    <WebhooksView
      orgId={String(ctx.org.id)}
      orgSlug={orgSlug}
      initial={endpoints}
      eventGroups={WEBHOOK_EVENT_GROUPS}
      canManage={ctx.allowed('webhook:manage')}
    />
  )
}
