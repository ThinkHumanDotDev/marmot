import { getPayload } from 'payload'

import config from '@payload-config'
import { resolveStatusPageLocale } from '@/i18n/resolve'
import {
  accessCacheControl,
  accessDeniedResponse,
  accessRequestFrom,
  checkStatusPageAccess,
} from '@/server/status-pages/access'
import { findPublishedStatusPage } from '@/server/status-pages/public'
import { buildStatusPageRss } from '@/server/status-pages/rss'
import { statusPageUrlFor } from '@/server/status-pages/urls'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ slug: string }> }

/**
 * GET /status/:slug/rss — RSS 2.0 feed of incidents and monitors currently down. Password-protected
 * pages need the access cookie or `?pw=` (401 otherwise).
 */
export async function GET(request: Request, { params }: RouteContext) {
  const { slug } = await params
  const payload = await getPayload({ config })
  const page = await findPublishedStatusPage(payload, slug)
  if (!page) return new Response('Not found', { status: 404 })

  const access = await checkStatusPageAccess(payload, page, accessRequestFrom(request))
  if (!access.allowed) return accessDeniedResponse(access, 'text')

  const locale = resolveStatusPageLocale(page, request.headers)
  const xml = await buildStatusPageRss(payload, page, statusPageUrlFor(page, request), locale)
  return new Response(xml, {
    headers: {
      'Content-Type': 'application/rss+xml; charset=utf-8',
      'Cache-Control': accessCacheControl(access, 'public, max-age=300'),
      ...(access.restricted ? { 'X-Robots-Tag': 'noindex, nofollow' } : {}),
    },
  })
}
