import { getPayload } from 'payload'

import config from '@payload-config'
import { findPublishedStatusPage } from '@/server/status-pages/public'
import { buildStatusPageRss } from '@/server/status-pages/rss'
import { statusPageUrlFor } from '@/server/status-pages/urls'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ slug: string }> }

/** GET /status/:slug/rss — RSS 2.0 feed of incidents and monitors currently down. */
export async function GET(request: Request, { params }: RouteContext) {
  const { slug } = await params
  const payload = await getPayload({ config })
  const page = await findPublishedStatusPage(payload, slug)
  if (!page) return new Response('Not found', { status: 404 })

  const xml = await buildStatusPageRss(payload, page, statusPageUrlFor(page, request))
  return new Response(xml, {
    headers: {
      'Content-Type': 'application/rss+xml; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
    },
  })
}
