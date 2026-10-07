import { buildStatusPageFeed } from '@/server/status-pages/feed'
import { toJsonFeed } from '@/server/status-pages/feed-formats'
import {
  corsPreflight,
  jsonDocument,
  publicStatusPageRoute,
} from '@/server/status-pages/public-api'

export const dynamic = 'force-dynamic'

/** GET /status/:slug/feed/json — JSON Feed 1.1 (the same items as RSS and Atom). */
export const GET = publicStatusPageRoute(async ({ payload, page, links, locale }) => {
  const feed = await buildStatusPageFeed(payload, page, links.page, locale)
  return jsonDocument(toJsonFeed(feed, links.jsonFeed), 'application/feed+json; charset=utf-8')
})

export const OPTIONS = corsPreflight
