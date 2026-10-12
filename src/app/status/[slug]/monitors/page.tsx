import type { Metadata } from 'next'
import { notFound } from 'next/navigation'

import { LatencyChartsView } from '@/components/status-pages/public/latency-charts'
import { CHARTS_PATH } from '@/lib/status-page-charts'
import { toPublicConfig } from '@/server/status-pages/public'

import { requireVisiblePage } from '../data'
import { StatusPageExtras } from '../extras'
import { chartRangeOf, chartsMetadata, loadCharts, type ChartSearchParams } from './charts-page'

export const dynamic = 'force-dynamic'

type PageProps = { params: Promise<{ slug: string }>; searchParams: Promise<ChartSearchParams> }

export async function generateMetadata({ params, searchParams }: PageProps): Promise<Metadata> {
  const { slug } = await params
  return chartsMetadata(slug, chartRangeOf(await searchParams))
}

/**
 * `/status/:slug/monitors` (and `/monitors` on custom domains): the latency charts of every
 * component the owner published (#113). 404 when the page publishes none.
 */
export default async function StatusPageCharts({ params, searchParams }: PageProps) {
  const { slug } = await params
  const { page, basePath, restricted } = await requireVisiblePage(slug, CHARTS_PATH)
  const range = chartRangeOf(await searchParams)
  const charts = await loadCharts(slug, range)
  if (charts.length === 0) notFound()
  const publicConfig = toPublicConfig(page)

  return (
    <>
      <StatusPageExtras config={publicConfig} restricted={restricted} />
      <main id="status-page-charts" data-slug={page.slug}>
        <LatencyChartsView
          config={publicConfig}
          basePath={basePath}
          range={range}
          charts={charts}
        />
      </main>
    </>
  )
}
