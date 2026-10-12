import { getPayload } from 'payload'

import config from '@payload-config'
import {
  accessCacheControl,
  accessDeniedResponse,
  accessRequestFrom,
  checkStatusPageAccess,
} from '@/server/status-pages/access'
import { scopePageForVisitor } from '@/server/status-pages/audiences'
import {
  DEFAULT_PUBLIC_CHART_RANGE,
  isPublicChartRange,
  PUBLIC_CHART_RANGES,
} from '@/lib/status-page-charts'
import { buildPageCharts } from '@/server/status-pages/latency-charts'
import { findPublishedStatusPage } from '@/server/status-pages/public'
import { errorText, requestLocale } from '@/server/request-locale'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ slug: string }> }

/**
 * GET /api/status-pages/:slug/charts?range=1d|7d|30d[&component=<componentId>]
 *
 * Anonymous. Latency percentiles, check counts and the per-location breakdown of the components
 * the page owner opted in to public charts (#113, `src/server/status-pages/latency-charts.ts`):
 * `{ range, components: [...] }`. Aggregates from the stat rollups only. Unknown pages are 404,
 * as is a `component` that does not publish charts; protected pages need access like the page
 * itself. Cached like the page's JSON (30 s).
 */
export async function GET(request: Request, { params }: RouteContext) {
  const { slug } = await params
  const payload = await getPayload({ config })
  const page = await findPublishedStatusPage(payload, slug)
  const noStore = { 'Cache-Control': 'no-store' }

  if (!page) {
    return Response.json(
      { error: errorText(request, 'statusPageNotFound') },
      { status: 404, headers: noStore },
    )
  }

  const access = await checkStatusPageAccess(payload, page, accessRequestFrom(request))
  if (!access.allowed) return accessDeniedResponse(access, 'json', requestLocale(request))

  const { searchParams } = new URL(request.url)
  const range = searchParams.get('range') ?? DEFAULT_PUBLIC_CHART_RANGE
  if (!isPublicChartRange(range)) {
    return Response.json(
      {
        error: errorText(request, 'statsRangeInvalid', { ranges: PUBLIC_CHART_RANGES.join(', ') }),
      },
      { status: 400, headers: noStore },
    )
  }
  const componentId = searchParams.get('component') ?? undefined

  // Audience pages (#151): only the visitor's components.
  const components = await buildPageCharts(payload, scopePageForVisitor(page, access), range, {
    componentId,
  })
  if (componentId !== undefined && components.length === 0) {
    return Response.json(
      { error: errorText(request, 'statusPageChartNotFound') },
      { status: 404, headers: noStore },
    )
  }

  return Response.json(
    { range, components, generatedAt: new Date().toISOString() },
    {
      headers: {
        'Cache-Control': accessCacheControl(access, 'public, max-age=30'),
        ...(access.restricted ? { 'X-Robots-Tag': 'noindex, nofollow' } : {}),
      },
    },
  )
}
