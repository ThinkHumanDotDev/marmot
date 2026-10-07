import { Webhook } from 'lucide-react'
import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'

import { EmptyState } from '@/components/empty-state'
import { WebhookDeliveriesView } from '@/components/settings/webhook-deliveries-view'
import { env } from '@/env'
import { getOrgPageContext } from '@/server/monitors/page-data'
import { listDeliveries, loadOrgEndpoint } from '@/server/webhooks/manage'
import { toEndpointRow } from '@/server/webhooks/rows'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('settings.pageTitles')
  return { title: t('webhookDeliveries') }
}
export const dynamic = 'force-dynamic'

/** Settings → Webhooks → one endpoint's delivery log (`webhook:read`). */
export default async function WebhookDeliveriesPage({
  params,
}: {
  params: Promise<{ orgSlug: string; id: string }>
}) {
  const { orgSlug, id } = await params
  const ctx = await getOrgPageContext(orgSlug, `/${orgSlug}/settings/webhooks/${id}`)
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

  const webhookCtx = { payload: ctx.payload, user: ctx.requestUser, orgId: ctx.org.id }
  const endpoint = await loadOrgEndpoint(webhookCtx, id)
  if (!endpoint) notFound()
  const initial = await listDeliveries(webhookCtx, endpoint)
  return (
    <WebhookDeliveriesView
      orgId={String(ctx.org.id)}
      orgSlug={orgSlug}
      endpoint={toEndpointRow(endpoint)}
      initial={initial}
      canManage={ctx.allowed('webhook:manage')}
      retentionDays={env.WEBHOOK_DELIVERY_RETENTION_DAYS}
    />
  )
}
