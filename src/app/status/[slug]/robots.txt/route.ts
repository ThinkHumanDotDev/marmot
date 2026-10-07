import { getPayload } from 'payload'

import config from '@payload-config'
import { findPublishedStatusPage } from '@/server/status-pages/public'
import { renderRobotsTxt } from '@/server/status-pages/seo'
import { statusPageUrlFor } from '@/server/status-pages/urls'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ slug: string }> }

/**
 * GET /status/:slug/robots.txt — served as `/robots.txt` on the page's custom domains. Indexable
 * pages point crawlers at their sitemap; protected pages and pages with indexing off disallow
 * everything. Reveals nothing about the page, so it needs no access check.
 */
export async function GET(request: Request, { params }: RouteContext) {
  const { slug } = await params
  const payload = await getPayload({ config })
  const page = await findPublishedStatusPage(payload, slug)
  if (!page)
    return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } })

  return new Response(renderRobotsTxt(page, statusPageUrlFor(page, request)), {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  })
}
