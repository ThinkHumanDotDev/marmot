import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'

import { IncidentDetail } from '@/components/incidents/incident-detail'
import { PageHeader } from '@/components/page-header'
import type { MonitorIncidentSummary } from '@/lib/monitor-incidents'
import { loadOrgIncident, renderTime, serializeIncident } from '@/server/incidents/store'
import { parseId } from '@/server/monitors/http'
import { getOrgPageContext, type OrgPageContext } from '@/server/monitors/page-data'

export const dynamic = 'force-dynamic'

interface IncidentPageProps {
  params: Promise<{ orgSlug: string; id: string }>
}

async function load(ctx: OrgPageContext, id: string): Promise<MonitorIncidentSummary> {
  if (!ctx.allowed('monitor-incident:read')) notFound()
  const doc = await loadOrgIncident(
    ctx.payload,
    ctx.requestUser,
    ctx.org.id,
    parseId(ctx.payload, id),
  )
  if (!doc) notFound()
  return serializeIncident(ctx.payload, doc)
}

export async function generateMetadata({ params }: IncidentPageProps): Promise<Metadata> {
  const { orgSlug, id } = await params
  const ctx = await getOrgPageContext(orgSlug, `/${orgSlug}/incidents/${id}`)
  const incident = await load(ctx, id)
  const t = await getTranslations('incidents.detail')
  const monitor = incident.monitor?.name ?? ''
  return {
    title:
      incident.status === 'resolved' ? t('titleResolved', { monitor }) : t('title', { monitor }),
  }
}

/** One monitor incident: facts, acknowledge / resolve / publish, timeline. */
export default async function IncidentPage({ params }: IncidentPageProps) {
  const { orgSlug, id } = await params
  const ctx = await getOrgPageContext(orgSlug, `/${orgSlug}/incidents/${id}`)
  const incident = await load(ctx, id)
  const t = await getTranslations('incidents.detail')
  const tl = await getTranslations('incidents.list')
  const canPublish = ctx.allowed('status-page:update')

  const statusPages = canPublish
    ? await ctx.payload.find({
        collection: 'status-pages',
        where: { organization: { equals: ctx.org.id } },
        sort: 'title',
        limit: 200,
        pagination: false,
        depth: 0,
        user: ctx.requestUser,
        overrideAccess: false,
        select: { title: true },
      })
    : { docs: [] }
  const monitor = incident.monitor?.name || tl('unknownMonitor')

  return (
    <>
      <PageHeader
        eyebrow={
          <Link href={`/${orgSlug}/incidents`} className="hover:text-foreground">
            {t('breadcrumb')}
          </Link>
        }
        title={
          incident.status === 'resolved' ? t('titleResolved', { monitor }) : t('title', { monitor })
        }
      />
      <section className="p-4 sm:p-6 md:p-8">
        <IncidentDetail
          orgId={ctx.org.id}
          orgSlug={orgSlug}
          initial={incident}
          canAcknowledge={ctx.allowed('monitor-incident:acknowledge')}
          canResolve={ctx.allowed('monitor-incident:resolve')}
          canPublish={canPublish}
          statusPages={statusPages.docs.map((page) => ({ id: String(page.id), title: page.title }))}
          now={renderTime()}
        />
      </section>
    </>
  )
}
