import { ChartLine } from 'lucide-react'
import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'

import { EmptyState } from '@/components/empty-state'
import { MetricsSettings } from '@/components/settings/metrics-settings'
import { listMetrics } from '@/server/metrics/manage'
import { getOrgPageContext } from '@/server/monitors/page-data'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('settings.pageTitles')
  return { title: t('metrics') }
}
export const dynamic = 'force-dynamic'

/**
 * Settings → Metrics: custom metrics published on status pages (#155). Needs `metric:read`
 * (everyone by default); changes need `metric:update` (members).
 */
export default async function MetricsSettingsPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>
}) {
  const { orgSlug } = await params
  const ctx = await getOrgPageContext(orgSlug, `/${orgSlug}/settings/metrics`)
  if (!ctx.allowed('metric:read')) {
    const t = await getTranslations('settings.metrics')
    return <EmptyState icon={ChartLine} title={t('forbiddenTitle')} description={t('forbidden')} />
  }

  const scope = { user: ctx.requestUser, overrideAccess: false, depth: 0, limit: 500 } as const
  const [metrics, monitors, pages] = await Promise.all([
    listMetrics({ payload: ctx.payload, user: ctx.requestUser, orgId: ctx.org.id }),
    ctx.payload.find({
      collection: 'monitors',
      where: { organization: { equals: ctx.org.id } },
      sort: 'name',
      select: { name: true },
      ...scope,
    }),
    ctx.payload.find({
      collection: 'status-pages',
      where: { organization: { equals: ctx.org.id } },
      sort: 'title',
      select: { title: true },
      ...scope,
    }),
  ])

  return (
    <MetricsSettings
      orgId={String(ctx.org.id)}
      initial={metrics}
      monitors={monitors.docs.map((doc) => ({ id: String(doc.id), name: doc.name }))}
      statusPages={pages.docs.map((doc) => ({ id: String(doc.id), name: doc.title }))}
      canManage={ctx.allowed('metric:update')}
    />
  )
}
