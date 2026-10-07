import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'

import { IncidentList } from '@/components/incidents/incident-list'
import { PageHeader } from '@/components/page-header'
import { isIncidentRange, isIncidentStatusFilter } from '@/lib/monitor-incidents'
import { listOrgIncidents, renderTime } from '@/server/incidents/store'
import { getOrgPageContext } from '@/server/monitors/page-data'
import { parseId } from '@/server/monitors/http'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('incidents.list')
  return { title: t('pageTitle') }
}

export const dynamic = 'force-dynamic'

interface IncidentsPageProps {
  params: Promise<{ orgSlug: string }>
  searchParams: Promise<{ status?: string; range?: string; monitor?: string; page?: string }>
}

/** Monitor incidents of the organization: filters, MTTA/MTTR summary and a paginated list. */
export default async function IncidentsPage({ params, searchParams }: IncidentsPageProps) {
  const { orgSlug } = await params
  const query = await searchParams
  const ctx = await getOrgPageContext(orgSlug, `/${orgSlug}/incidents`)
  if (!ctx.allowed('monitor-incident:read')) notFound()
  const t = await getTranslations('incidents.list')

  const filters = {
    status: isIncidentStatusFilter(query.status) ? query.status : 'all',
    range: isIncidentRange(query.range) ? query.range : '30d',
    monitor: query.monitor || null,
  } as const
  const page = Math.max(1, Number.parseInt(query.page ?? '1', 10) || 1)
  const now = renderTime()

  const [result, monitors] = await Promise.all([
    listOrgIncidents(ctx.payload, ctx.org.id, {
      status: filters.status,
      range: filters.range,
      monitor: filters.monitor ? parseId(ctx.payload, filters.monitor) : null,
      page,
      now: new Date(now),
      user: ctx.requestUser,
    }),
    ctx.payload.find({
      collection: 'monitors',
      where: { organization: { equals: ctx.org.id } },
      sort: 'name',
      limit: 1000,
      pagination: false,
      depth: 0,
      user: ctx.requestUser,
      overrideAccess: false,
      select: { name: true },
    }),
  ])

  return (
    <>
      <PageHeader title={t('title')} description={t('description')} />
      <section className="p-4 sm:p-6 md:p-8">
        <IncidentList
          orgId={ctx.org.id}
          orgSlug={orgSlug}
          docs={result.docs}
          stats={result.stats}
          page={result.page}
          totalPages={result.totalPages}
          filters={filters}
          monitors={monitors.docs.map((monitor) => ({
            id: String(monitor.id),
            name: monitor.name,
          }))}
          now={now}
        />
      </section>
    </>
  )
}
