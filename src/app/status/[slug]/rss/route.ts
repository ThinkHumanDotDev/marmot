import { corsPreflight, publicStatusPageRoute } from '@/server/status-pages/public-api'
import { buildStatusPageRss } from '@/server/status-pages/rss'

export const dynamic = 'force-dynamic'

/**
 * GET /status/:slug/rss — RSS 2.0 feed of incident updates and monitors currently down.
 * Password-protected pages need the access cookie or `?pw=` (401 otherwise).
 */
export const GET = publicStatusPageRoute(async ({ payload, page, links, locale }) => ({
  body: await buildStatusPageRss(payload, page, links.page, locale),
  contentType: 'application/rss+xml; charset=utf-8',
}))

export const OPTIONS = corsPreflight
