import 'server-only'

import type { Metadata } from 'next'
import { headers } from 'next/headers'
import { getTranslations } from 'next-intl/server'
import { getPayload } from 'payload'
import { cache } from 'react'

import config from '@payload-config'
import { getStatusPageLocale } from '@/i18n/server'
import {
  CHARTS_PATH,
  componentChartPath,
  DEFAULT_PUBLIC_CHART_RANGE,
  isPublicChartRange,
  type PublicChartRange,
} from '@/lib/status-page-charts'
import { isProtectedPage } from '@/server/status-pages/access'
import { buildPageCharts, type PublicComponentChart } from '@/server/status-pages/latency-charts'
import { NOINDEX, statusPageMetadata } from '@/server/status-pages/seo'
import {
  localeAlternates,
  statusPageLocalePath,
  statusPageUrlForHeaders,
} from '@/server/status-pages/urls'

import { loadPageAccess, loadPublishedPage } from '../data'

export type ChartSearchParams = Record<string, string | string[] | undefined>

/** The `?range=` of a chart page, defaulting to 24 hours. */
export const chartRangeOf = (searchParams: ChartSearchParams): PublicChartRange => {
  const value = searchParams.range
  return isPublicChartRange(value) ? value : DEFAULT_PUBLIC_CHART_RANGE
}

/** Charts of the page (or one component), memoised per request for metadata and page. */
export const loadCharts = cache(
  async (
    slug: string,
    range: PublicChartRange,
    componentId?: string,
  ): Promise<PublicComponentChart[]> => {
    const page = await loadPublishedPage(slug)
    if (!page) return []
    const payload = await getPayload({ config })
    return buildPageCharts(payload, page, range, { componentId })
  },
)

/** Metadata of the overview (`componentId` omitted) or of one component's charts. */
export async function chartsMetadata(
  slug: string,
  range: PublicChartRange,
  componentId?: string,
): Promise<Metadata> {
  const page = await loadPublishedPage(slug)
  const locale = await getStatusPageLocale(page)
  if (!page) {
    const t = await getTranslations({ locale, namespace: 'statusPages.notFound' })
    return { title: t('pageTitle'), robots: NOINDEX }
  }
  if (isProtectedPage(page) && !(await loadPageAccess(slug))?.allowed) {
    return { title: page.title, robots: NOINDEX }
  }
  const t = await getTranslations({ locale, namespace: 'statusPages.seo' })
  const requestHeaders = await headers()
  const base = statusPageUrlForHeaders(page, requestHeaders)
  const feedBase = statusPageLocalePath(page, requestHeaders)
  if (componentId === undefined) {
    return statusPageMetadata(page, {
      languages: localeAlternates(page, requestHeaders, CHARTS_PATH),
      feedBase,
      title: t('chartsTitle', { siteName: page.title }),
      description: t('chartsDescription', { siteName: page.title }),
      url: `${base}${CHARTS_PATH}`,
    })
  }
  const [chart] = await loadCharts(slug, range, componentId)
  if (!chart) return { title: page.title, robots: NOINDEX }
  return statusPageMetadata(page, {
    languages: localeAlternates(page, requestHeaders, componentChartPath(chart.componentId)),
    feedBase,
    title: t('componentChartTitle', { name: chart.name, siteName: page.title }),
    description: t('componentChartDescription', { name: chart.name, siteName: page.title }),
    url: `${base}${componentChartPath(chart.componentId)}`,
  })
}
