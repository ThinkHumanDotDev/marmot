import { getPayload } from 'payload'

import config from '@payload-config'
import { sitemapEvents } from '@/server/status-pages/events'
import { findPublishedStatusPage } from '@/server/status-pages/public'
import { isIndexable, renderSitemap } from '@/server/status-pages/seo'
import { statusPageUrlFor } from '@/server/status-pages/urls'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ slug: string }> }

/**
 * GET /status/:slug/sitemap.xml (and `/sitemap.xml` on the page's custom domains) — the page, its
 * history and every incident and maintenance permalink. Only pages that may be indexed have one
 * (published, search engine indexing on, not access-protected); the others answer 404.
 */
export async function GET(request: Request, { params }: RouteContext) {
  const { slug } = await params
  const payload = await getPayload({ config })
  const page = await findPublishedStatusPage(payload, slug)
  if (!page || !isIndexable(page)) {
    return new Response('Not found', {
      status: 404,
      headers: { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' },
    })
  }

  const xml = renderSitemap(statusPageUrlFor(page, request), await sitemapEvents(payload, page))
  return new Response(xml, {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  })
}
