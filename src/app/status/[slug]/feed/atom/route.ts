import { buildStatusPageFeed } from '@/server/status-pages/feed'
import { renderAtom } from '@/server/status-pages/feed-formats'
import { corsPreflight, publicStatusPageRoute } from '@/server/status-pages/public-api'

export const dynamic = 'force-dynamic'

/** GET /status/:slug/feed/atom — Atom 1.0 feed (the same items as RSS and JSON Feed). */
export const GET = publicStatusPageRoute(async ({ payload, page, links, locale }) => {
  const feed = await buildStatusPageFeed(payload, page, links.page, locale)
  return {
    body: renderAtom(feed, links.atom),
    contentType: 'application/atom+xml; charset=utf-8',
  }
})

export const OPTIONS = corsPreflight
