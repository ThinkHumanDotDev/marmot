import type { Metadata } from 'next'
import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { redirect } from 'next/navigation'

import { MonitorForm } from '@/components/monitors/monitor-form'
import { PageHeader } from '@/components/page-header'
import { monitorToFormValues } from '@/lib/validation/monitor'
import { listMonitorTypes } from '@/server/monitor-types'
import {
  getMonitorFormResources,
  getOrgGroups,
  getOrgMonitor,
  getOrgPageContext,
} from '@/server/monitors/page-data'

export const dynamic = 'force-dynamic'

interface EditMonitorPageProps {
  params: Promise<{ orgSlug: string; id: string }>
}

export async function generateMetadata({ params }: EditMonitorPageProps): Promise<Metadata> {
  const { orgSlug, id } = await params
  const ctx = await getOrgPageContext(orgSlug, `/${orgSlug}/monitors/${id}/edit`)
  const monitor = await getOrgMonitor(ctx, id, 0)
  const t = await getTranslations('monitors.edit')
  return { title: t('pageTitle', { name: monitor.name }) }
}

export default async function EditMonitorPage({ params }: EditMonitorPageProps) {
  const { orgSlug, id } = await params
  const ctx = await getOrgPageContext(orgSlug, `/${orgSlug}/monitors/${id}/edit`)
  const monitor = await getOrgMonitor(ctx, id, 0)
  if (!ctx.allowed('monitor:update')) redirect(`/${orgSlug}/monitors/${monitor.id}`)

  const [groups, resources] = await Promise.all([getOrgGroups(ctx), getMonitorFormResources(ctx)])
  const t = await getTranslations('monitors.edit')
  const types = listMonitorTypes().map(({ name, label }) => ({ name, label }))

  return (
    <>
      <PageHeader
        eyebrow={
          <Link href={`/${orgSlug}/monitors/${monitor.id}`} className="hover:text-foreground">
            ← {monitor.name}
          </Link>
        }
        title={t('title')}
        description={t('description')}
      />
      <section className="p-4 sm:p-6 md:p-8">
        <MonitorForm
          mode="edit"
          orgId={ctx.org.id}
          orgSlug={orgSlug}
          monitorId={monitor.id}
          initialValues={monitorToFormValues(monitor)}
          types={types}
          groups={groups}
          resources={resources}
        />
      </section>
    </>
  )
}
