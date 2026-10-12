import { Download, FileX } from 'lucide-react'
import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'
import { getPayload } from 'payload'

import config from '@payload-config'
import { EmptyState } from '@/components/empty-state'
import { PrintButton } from '@/components/sla/print-button'
import { SlaReportTable } from '@/components/sla/report-table'
import { Button } from '@/components/ui/button'
import { relationId } from '@/server/maintenance/serialize'
import { buildSlaReport } from '@/server/sla/compute'
import { resolveShare } from '@/server/sla/shares'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('sla.public')
  return {
    title: t('pageTitle'),
    robots: { index: false, follow: false },
    referrer: 'no-referrer',
  }
}

export const dynamic = 'force-dynamic'

/**
 * Public, read-only SLA report behind a share link (#156): server-rendered and print-friendly.
 * Exposes the shared report over the link's range only; revoked or unknown links show the same
 * "not available" page.
 */
export default async function SharedSlaReportPage({
  params,
}: {
  params: Promise<{ token: string }>
}) {
  const { token } = await params
  const t = await getTranslations('sla')
  const payload = await getPayload({ config })
  const shared = await resolveShare(payload, token)

  if (!shared) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-xl items-center px-4">
        <EmptyState
          className="w-full"
          icon={FileX}
          title={t('public.notFoundTitle')}
          description={t('public.notFoundDescription')}
        />
      </main>
    )
  }

  const data = await buildSlaReport(payload, shared.report, shared.period)
  const orgId = relationId(shared.report.organization)
  const org =
    orgId === null
      ? null
      : await payload
          .findByID({
            collection: 'organizations',
            id: orgId,
            depth: 0,
            overrideAccess: true,
            select: { name: true },
          })
          .catch(() => null)
  const download = `/api/sla/${token}`

  return (
    <main className="mx-auto max-w-5xl space-y-6 px-4 py-10 print:max-w-none print:py-0">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-1">
          {org?.name && (
            <p className="text-sm text-muted-foreground">
              {t('public.sharedBy', { organization: org.name })}
            </p>
          )}
          <h1 className="text-2xl font-semibold tracking-tight">{data.name}</h1>
        </div>
        <div className="flex gap-2 print:hidden">
          <Button variant="outline" size="sm" asChild>
            <a href={`${download}?format=csv`} download>
              <Download /> {t('report.downloadCsv')}
            </a>
          </Button>
          <Button variant="outline" size="sm" asChild>
            <a href={`${download}?format=pdf`} download>
              <Download /> {t('report.downloadPdf')}
            </a>
          </Button>
          <PrintButton label={t('report.print')} />
        </div>
      </header>
      <SlaReportTable report={data} />
    </main>
  )
}
