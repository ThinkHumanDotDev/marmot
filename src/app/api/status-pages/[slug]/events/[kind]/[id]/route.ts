import { getPayload } from 'payload'

import config from '@payload-config'
import { isEventKind } from '@/lib/status-page-events'
import {
  accessCacheControl,
  accessDeniedResponse,
  accessRequestFrom,
  checkStatusPageAccess,
} from '@/server/status-pages/access'
import { getIncidentEvent, getMaintenanceEvent } from '@/server/status-pages/events'
import { findPublishedStatusPage } from '@/server/status-pages/public'
import { robotsHeader } from '@/server/status-pages/seo'
import { errorText, requestLocale } from '@/server/request-locale'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ slug: string; kind: string; id: string }> }

/**
 * GET /api/status-pages/:slug/events/incident/:publicId and …/maintenance/:publicId
 *
 * Anonymous. One incident (`{ incident, summary }`) or maintenance window
 * (`{ maintenance, summary }`) of the page, by the short id of its permalink. 404 for unknown ids,
 * events of other pages and maintenance windows that are not public; 401 without access to a
 * protected page.
 */
export async function GET(request: Request, { params }: RouteContext) {
  const { slug, kind, id } = await params
  const payload = await getPayload({ config })
  const page = await findPublishedStatusPage(payload, slug)
  const notFound = () =>
    Response.json(
      { error: errorText(request, page ? 'statusPageEventNotFound' : 'statusPageNotFound') },
      { status: 404, headers: { 'Cache-Control': 'no-store' } },
    )
  if (!page) return notFound()

  const access = await checkStatusPageAccess(payload, page, accessRequestFrom(request))
  if (!access.allowed) return accessDeniedResponse(access, 'json', requestLocale(request))

  if (!isEventKind(kind)) return notFound()
  const event =
    kind === 'incident'
      ? await getIncidentEvent(payload, page, id)
      : await getMaintenanceEvent(payload, page, id)
  if (!event) return notFound()

  return Response.json(event, {
    headers: {
      'Cache-Control': accessCacheControl(access, 'public, max-age=60'),
      ...robotsHeader(page),
    },
  })
}
