/**
 * RSS 2.0 feed of a status page: one item per incident update (newest first) and monitors that are
 * currently down. The items come from the shared feed model (`./feed`), which Atom and JSON Feed
 * render too.
 * Mirrors Uptime Kuma's `StatusPage.renderRSS` (MIT) with a hand-written XML builder instead of
 * the `feed` package.
 */
import type { Payload } from 'payload'

import type { Locale } from '@/i18n/locales'
import { resolveStatusPageLocale } from '@/i18n/resolve'
import type { StatusPage } from '@/payload-types'

import { buildStatusPageFeed, type StatusPageFeed } from './feed'

export { findFeedIncidents, incidentUpdateItems, MAX_FEED_ITEMS } from './feed'

export const escapeXml = (value: string): string =>
  value.replace(
    /[<>&'"]/g,
    (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c] as string,
  )

export interface RssItem {
  title: string
  description: string
  link: string
  guid: string
  /** RFC 822 date. */
  pubDate: Date
}

export interface RssChannel {
  title: string
  description: string
  link: string
  /** RFC 1766 language code of the channel. */
  language: string
  /** URL of the feed itself (`atom:link rel="self"`). */
  feedUrl: string
  items: RssItem[]
  lastBuildDate?: Date
}

const element = (name: string, value: string) => `<${name}>${escapeXml(value)}</${name}>`

/** Serialises an RSS 2.0 document. All text is XML-escaped; descriptions may contain HTML. */
export function renderRss(channel: RssChannel): string {
  const items = channel.items
    .map(
      (item) =>
        `    <item>\n` +
        `      ${element('title', item.title)}\n` +
        `      ${element('link', item.link)}\n` +
        `      <guid isPermaLink="false">${escapeXml(item.guid)}</guid>\n` +
        `      ${element('pubDate', item.pubDate.toUTCString())}\n` +
        `      ${element('description', item.description)}\n` +
        `    </item>`,
    )
    .join('\n')

  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">\n` +
    `  <channel>\n` +
    `    ${element('title', channel.title)}\n` +
    `    ${element('link', channel.link)}\n` +
    `    ${element('description', channel.description)}\n` +
    `    ${element('language', channel.language)}\n` +
    `    ${element('lastBuildDate', (channel.lastBuildDate ?? new Date()).toUTCString())}\n` +
    `    <atom:link href="${escapeXml(channel.feedUrl)}" rel="self" type="application/rss+xml"/>\n` +
    (items ? `${items}\n` : '') +
    `  </channel>\n` +
    `</rss>\n`
  )
}

/** The shared feed model as an RSS channel. */
export const rssFromFeed = (feed: StatusPageFeed, feedUrl: string): RssChannel => ({
  title: feed.title,
  description: feed.description,
  link: feed.link,
  language: feed.language,
  feedUrl,
  lastBuildDate: feed.updated,
  items: feed.items.map((item) => ({
    title: item.title,
    description: item.html,
    link: item.url,
    guid: item.guid,
    pubDate: item.published,
  })),
})

/**
 * Builds the RSS feed for a published status page. `pageUrl` is the public URL of the page; the
 * text is rendered in `locale` (`statusPageFeedLocale`) with times in the organization's zone.
 */
export async function buildStatusPageRss(
  payload: Payload,
  page: StatusPage,
  pageUrl: string,
  locale: Locale = resolveStatusPageLocale(page, new Headers()),
): Promise<string> {
  const feed = await buildStatusPageFeed(payload, page, pageUrl, locale)
  return renderRss(rssFromFeed(feed, `${pageUrl}/rss`))
}
