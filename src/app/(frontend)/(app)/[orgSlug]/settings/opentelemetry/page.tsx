import { Telescope } from 'lucide-react'
import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'

import { EmptyState } from '@/components/empty-state'
import { OtelCollectorsSettings } from '@/components/settings/otel-collectors-settings'
import { getOrgPageContext } from '@/server/monitors/page-data'
import { listCollectors } from '@/server/otel/manage'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('settings.pageTitles')
  return { title: t('openTelemetry') }
}
export const dynamic = 'force-dynamic'

/**
 * Settings → OpenTelemetry: the organization's OTLP metrics collectors (#99). Needs
 * `otel-collector:read` (members by default); changes need `otel-collector:manage` (admins).
 */
export default async function OpenTelemetrySettingsPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>
}) {
  const { orgSlug } = await params
  const ctx = await getOrgPageContext(orgSlug, `/${orgSlug}/settings/opentelemetry`)
  if (!ctx.allowed('otel-collector:read')) {
    const t = await getTranslations('settings.openTelemetry')
    return (
      <EmptyState
        icon={Telescope}
        title={t('membersOnlyTitle')}
        description={t('membersOnlyDescription')}
      />
    )
  }

  const collectors = await listCollectors({
    payload: ctx.payload,
    user: ctx.requestUser,
    orgId: ctx.org.id,
  })
  return (
    <OtelCollectorsSettings
      orgId={String(ctx.org.id)}
      initial={collectors}
      canManage={ctx.allowed('otel-collector:manage')}
    />
  )
}
