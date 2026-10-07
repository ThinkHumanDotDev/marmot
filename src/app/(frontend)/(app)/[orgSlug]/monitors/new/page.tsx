import type { Metadata } from 'next'
import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { redirect } from 'next/navigation'

import { MonitorForm } from '@/components/monitors/monitor-form'
import { PageHeader } from '@/components/page-header'
import {
  defaultMonitorValues,
  MONITOR_TYPE_NAMES,
  type MonitorTypeName,
} from '@/lib/validation/monitor'
import { listMonitorTypes } from '@/server/monitor-types'
import {
  getMonitorFormResources,
  getOrgGroups,
  getOrgPageContext,
} from '@/server/monitors/page-data'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('monitors.new')
  return { title: t('pageTitle') }
}

export const dynamic = 'force-dynamic'

interface NewMonitorPageProps {
  params: Promise<{ orgSlug: string }>
  searchParams: Promise<{ type?: string }>
}

export default async function NewMonitorPage({ params, searchParams }: NewMonitorPageProps) {
  const { orgSlug } = await params
  const { type } = await searchParams
  const ctx = await getOrgPageContext(orgSlug, `/${orgSlug}/monitors/new`)
  if (!ctx.allowed('monitor:create')) redirect(`/${orgSlug}/monitors`)

  const initialType: MonitorTypeName = (MONITOR_TYPE_NAMES as readonly string[]).includes(
    type ?? '',
  )
    ? (type as MonitorTypeName)
    : 'http'
  const [groups, resources] = await Promise.all([getOrgGroups(ctx), getMonitorFormResources(ctx)])
  // Uptime Kuma preselects the default proxy for new monitors.
  const defaultProxy = resources.proxies.find((p) => p.isDefault && p.active)
  const initialValues = {
    ...defaultMonitorValues(initialType),
    proxy: defaultProxy ? defaultProxy.id : null,
  }
  const t = await getTranslations('monitors.new')
  const types = listMonitorTypes().map(({ name, label }) => ({ name, label }))

  return (
    <>
      <PageHeader
        eyebrow={
          <Link href={`/${orgSlug}/monitors`} className="hover:text-foreground">
            {t('back')}
          </Link>
        }
        title={t('title')}
        description={t('description')}
      />
      <section className="p-4 sm:p-6 md:p-8">
        <MonitorForm
          mode="create"
          orgId={ctx.org.id}
          orgSlug={orgSlug}
          initialValues={initialValues}
          types={types}
          groups={groups}
          resources={resources}
        />
      </section>
    </>
  )
}
