import type { Metadata } from 'next'
import { notFound } from 'next/navigation'

import { LatencyChartsView } from '@/components/status-pages/public/latency-charts'
import { COMPONENT_ID_PATTERN, componentChartPath } from '@/lib/status-page-charts'
import { toPublicConfig } from '@/server/status-pages/public'

import { requireVisiblePage } from '../../data'
import { StatusPageExtras } from '../../extras'
import { chartRangeOf, chartsMetadata, loadCharts, type ChartSearchParams } from '../charts-page'

export const dynamic = 'force-dynamic'

type PageProps = {
  params: Promise<{ slug: string; componentId: string }>
  searchParams: Promise<ChartSearchParams>
}

export async function generateMetadata({ params, searchParams }: PageProps): Promise<Metadata> {
  const { slug, componentId } = await params
  return chartsMetadata(slug, chartRangeOf(await searchParams), componentId.toLowerCase())
}

/**
 * `/status/:slug/monitors/:componentId` (and `/monitors/:componentId` on custom domains): one
 * component's latency charts (#113). 404 unless the owner published charts for it.
 */
export default async function ComponentChartPage({ params, searchParams }: PageProps) {
  const { slug, componentId: raw } = await params
  const componentId = raw.toLowerCase()
  if (!COMPONENT_ID_PATTERN.test(componentId)) notFound()
  const { page, basePath, restricted } = await requireVisiblePage(
    slug,
    componentChartPath(componentId),
  )
  const range = chartRangeOf(await searchParams)
  const charts = await loadCharts(slug, range, componentId)
  if (charts.length === 0) notFound()
  const publicConfig = toPublicConfig(page)

  return (
    <>
      <StatusPageExtras config={publicConfig} restricted={restricted} />
      <main id="status-page-component-chart" data-slug={page.slug}>
        <LatencyChartsView
          config={publicConfig}
          basePath={basePath}
          range={range}
          charts={charts}
          single
        />
      </main>
    </>
  )
}
