import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'

import { PageHeader } from '@/components/page-header'
import { SlaDashboard } from '@/components/sla/sla-dashboard'
import { toReportRowView } from '@/components/sla/sla-api'
import { getOrgPageContext } from '@/server/monitors/page-data'
import { targetStatuses } from '@/server/sla/compute'
import {
  channelOptions,
  listOrgReports,
  listOrgTargets,
  statusPageOptions,
} from '@/server/sla/manage'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('sla')
  return { title: t('pageTitle') }
}

export const dynamic = 'force-dynamic'

/** SLA targets with their current error budget, and the organization's reports (#156). */
export default async function SlaPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = await params
  const ctx = await getOrgPageContext(orgSlug, `/${orgSlug}/sla`)
  if (!ctx.allowed('sla:read')) notFound()
  const t = await getTranslations('sla')
  const user = { payload: ctx.payload, user: ctx.requestUser, orgId: ctx.org.id }
  const canManage = ctx.allowed('sla:manage')

  const [targets, reports, monitors, statusPages, channels] = await Promise.all([
    listOrgTargets(user).then((docs) => targetStatuses(ctx.payload, docs)),
    listOrgReports(user),
    canManage
      ? ctx.payload.find({
          collection: 'monitors',
          where: { organization: { equals: ctx.org.id } },
          sort: 'name',
          limit: 1000,
          pagination: false,
          depth: 0,
          user: ctx.requestUser,
          overrideAccess: false,
          select: { name: true },
        })
      : { docs: [] },
    canManage ? statusPageOptions(user) : [],
    canManage ? channelOptions(user) : [],
  ])

  return (
    <>
      <PageHeader title={t('title')} description={t('description')} />
      <section className="p-4 sm:p-6 md:p-8">
        <SlaDashboard
          orgId={String(ctx.org.id)}
          orgSlug={orgSlug}
          targets={targets}
          reports={reports.map((doc) => toReportRowView(doc as never))}
          monitors={monitors.docs.map((m) => ({ id: String(m.id), name: m.name }))}
          statusPages={statusPages}
          channels={channels}
          canManage={canManage}
        />
      </section>
    </>
  )
}
