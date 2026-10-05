import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'

import { MonitorForm } from '@/components/monitors/monitor-form'
import { PageHeader } from '@/components/page-header'
import {
  defaultMonitorValues,
  MONITOR_TYPE_NAMES,
  type MonitorTypeName,
} from '@/lib/validation/monitor'
import { listMonitorTypes } from '@/server/monitor-types'
import { getOrgGroups, getOrgPageContext } from '@/server/monitors/page-data'

export const metadata: Metadata = { title: 'New monitor' }
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
  const groups = await getOrgGroups(ctx)
  const types = listMonitorTypes().map(({ name, label }) => ({ name, label }))

  return (
    <>
      <PageHeader
        eyebrow={
          <Link href={`/${orgSlug}/monitors`} className="hover:text-foreground">
            ← Monitors
          </Link>
        }
        title="New monitor"
        description="Marmot starts checking as soon as you save."
      />
      <section className="p-4 sm:p-6 md:p-8">
        <MonitorForm
          mode="create"
          orgId={ctx.org.id}
          orgSlug={orgSlug}
          initialValues={defaultMonitorValues(initialType)}
          types={types}
          groups={groups}
        />
      </section>
    </>
  )
}
