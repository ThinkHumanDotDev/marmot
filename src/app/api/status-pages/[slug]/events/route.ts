import { getPayload } from 'payload'

import config from '@payload-config'
import { parseEventFilters } from '@/lib/status-page-events'
import {
  accessCacheControl,
  accessDeniedResponse,
  accessRequestFrom,
  checkStatusPageAccess,
} from '@/server/status-pages/access'
import { listStatusPageEvents } from '@/server/status-pages/events'
import { findPublishedStatusPage } from '@/server/status-pages/public'
import { robotsHeader } from '@/server/status-pages/seo'
import { errorText, requestLocale } from '@/server/request-locale'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ slug: string }> }

/**
 * GET /api/status-pages/:slug/events?type=&component=&month=&page=
 *
 * Anonymous. The page's event history (incidents and maintenance windows, newest first, 20 per
 * page) as `{ events, page, totalPages, totalEvents, perPage, months, components, filters, range }`
 * (see `src/server/status-pages/events.ts`). Same access rules as the public JSON: 404 for unknown
 * or unpublished slugs, 401 without access to a protected page.
 */
export async function GET(request: Request, { params }: RouteContext) {
  const { slug } = await params
  const payload = await getPayload({ config })
  const page = await findPublishedStatusPage(payload, slug)
  if (!page) {
    return Response.json(
      { error: errorText(request, 'statusPageNotFound') },
      { status: 404, headers: { 'Cache-Control': 'no-store' } },
    )
  }

  const access = await checkStatusPageAccess(payload, page, accessRequestFrom(request))
  if (!access.allowed) return accessDeniedResponse(access, 'json', requestLocale(request))

  const filters = parseEventFilters(new URL(request.url).searchParams)
  const history = await listStatusPageEvents(payload, page, filters)
  return Response.json(history, {
    headers: {
      'Cache-Control': accessCacheControl(access, 'public, max-age=60'),
      ...robotsHeader(page),
    },
  })
}
