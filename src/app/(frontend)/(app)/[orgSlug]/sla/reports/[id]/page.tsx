import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'

import { PageHeader } from '@/components/page-header'
import { SlaReportTable } from '@/components/sla/report-table'
import { ReportToolbar } from '@/components/sla/report-toolbar'
import { SendReport } from '@/components/sla/send-report'
import { ShareLinks } from '@/components/sla/share-links'
import { periodDates, previousSchedulePeriod } from '@/lib/sla'
import { getOrgPageContext } from '@/server/monitors/page-data'
import { buildSlaReport } from '@/server/sla/compute'
import { loadOrgReport, rangeFromSearchParams } from '@/server/sla/manage'
import { listShares } from '@/server/sla/shares'
import { slaZoneOf } from '@/server/sla/zone'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('sla.report')
  return { title: t('pageTitle') }
}

export const dynamic = 'force-dynamic'

interface ReportPageProps {
  params: Promise<{ orgSlug: string; id: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

/** One SLA report over a range of days (default: last month), with downloads and share links. */
export default async function SlaReportPage({ params, searchParams }: ReportPageProps) {
  const { orgSlug, id } = await params
  const query = await searchParams
  const ctx = await getOrgPageContext(orgSlug, `/${orgSlug}/sla/reports/${id}`)
  if (!ctx.allowed('sla:read')) notFound()
  const user = { payload: ctx.payload, user: ctx.requestUser, orgId: ctx.org.id }
  const report = await loadOrgReport(user, id)
  if (!report) notFound()

  const now = new Date()
  const zone = slaZoneOf(ctx.org)
  const period = rangeFromSearchParams(query, now, zone)
  const basePath = `/${orgSlug}/sla/reports/${id}`
  if (!period) {
    const fallback = periodDates(previousSchedulePeriod('monthly', now, zone)!, zone)
    redirect(`${basePath}?from=${fallback.from}&to=${fallback.to}`)
  }
  const { from, to } = periodDates(period, zone)
  const canManage = ctx.allowed('sla:manage')
  const [data, shares] = await Promise.all([
    buildSlaReport(ctx.payload, report, period, now),
    canManage ? listShares(user, report) : [],
  ])
  const t = await getTranslations('sla.report')

  return (
    <>
      <PageHeader
        eyebrow={
          <>
            <Link href={`/${orgSlug}/sla`} className="hover:underline print:hidden">
              {t('back')}
            </Link>
            {/* The print view names the organization instead of linking back. */}
            <span className="hidden print:inline">{ctx.org.name}</span>
          </>
        }
        title={report.name}
        actions={
          canManage ? (
            <SendReport
              orgId={String(ctx.org.id)}
              reportId={String(report.id)}
              from={from}
              to={to}
              recipients={(report.recipients ?? []).map((row) => row.email)}
            />
          ) : undefined
        }
      />
      <section className="space-y-6 p-4 sm:p-6 md:p-8">
        <ReportToolbar
          basePath={basePath}
          downloadPath={`/api/orgs/${ctx.org.id}/sla/reports/${report.id}`}
          from={from}
          to={to}
          now={now.getTime()}
          zone={zone}
        />
        <SlaReportTable report={data} />
        {canManage && (
          <div className="print:hidden">
            <ShareLinks
              key={`${from}..${to}`}
              orgId={String(ctx.org.id)}
              reportId={String(report.id)}
              from={from}
              to={to}
              initial={shares}
            />
          </div>
        )}
      </section>
    </>
  )
}
