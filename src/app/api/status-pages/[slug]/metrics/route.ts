import { getPayload } from 'payload'

import config from '@payload-config'
import { isMetricView, METRIC_VIEWS } from '@/lib/metrics'
import { buildPublicMetrics } from '@/server/metrics/public'
import { errorText, requestLocale } from '@/server/request-locale'
import {
  accessCacheControl,
  accessDeniedResponse,
  accessRequestFrom,
  checkStatusPageAccess,
} from '@/server/status-pages/access'
import { findPublishedStatusPage } from '@/server/status-pages/public'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ slug: string }> }

/**
 * GET /api/status-pages/:slug/metrics[?metric=<id>&view=hour|day|week|month]
 *
 * Anonymous. The custom metrics the page publishes (#155, `src/server/metrics/public.ts`), each in
 * its default view or in `view`: `{ metrics: [...] }`. Aggregates from the rollups only. Unknown
 * pages are 404, as is a `metric` the page does not publish; protected pages need access like the
 * page itself. Cached like the page's JSON (30 s).
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
  const view = searchParams.get('view') ?? undefined
  if (view !== undefined && !isMetricView(view)) {
    return Response.json(
      { error: errorText(request, 'metricViewInvalid', { views: METRIC_VIEWS.join(', ') }) },
      { status: 400, headers: noStore },
    )
  }
  const metricId = searchParams.get('metric') ?? undefined
  const metrics = await buildPublicMetrics(payload, page, { metricId, view })
  if (metricId !== undefined && metrics.length === 0) {
    return Response.json(
      { error: errorText(request, 'metricNotFound') },
      { status: 404, headers: noStore },
    )
  }

  return Response.json(
    { metrics, generatedAt: new Date().toISOString() },
    {
      headers: {
        'Cache-Control': accessCacheControl(access, 'public, max-age=30'),
        ...(access.restricted ? { 'X-Robots-Tag': 'noindex, nofollow' } : {}),
      },
    },
  )
}
