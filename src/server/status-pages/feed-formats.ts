/**
 * Atom 1.0 (RFC 4287) and JSON Feed 1.1 (https://jsonfeed.org/version/1.1) renderers of the shared
 * status page feed model (`./feed`). RSS 2.0 lives in `./rss`.
 */
import type { StatusPageFeed } from './feed'
import { escapeXml } from './rss'

const text = (name: string, value: string) => `<${name}>${escapeXml(value)}</${name}>`

/** Serialises an Atom 1.0 feed. Entry content is HTML (`type="html"`, escaped). */
export function renderAtom(feed: StatusPageFeed, feedUrl: string): string {
  const entries = feed.items
    .map(
      (item) =>
        `  <entry>\n` +
        `    ${text('id', item.id)}\n` +
        `    <title type="text">${escapeXml(item.title)}</title>\n` +
        `    <link rel="alternate" type="text/html" href="${escapeXml(item.url)}"/>\n` +
        `    ${text('published', item.published.toISOString())}\n` +
        `    ${text('updated', item.updated.toISOString())}\n` +
        `    <content type="html">${escapeXml(item.html)}</content>\n` +
        `  </entry>`,
    )
    .join('\n')

  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="${escapeXml(feed.language)}">\n` +
    `  ${text('id', feed.id)}\n` +
    `  <title type="text">${escapeXml(feed.title)}</title>\n` +
    `  <subtitle type="text">${escapeXml(feed.description)}</subtitle>\n` +
    `  ${text('updated', feed.updated.toISOString())}\n` +
    `  <link rel="alternate" type="text/html" href="${escapeXml(feed.link)}"/>\n` +
    `  <link rel="self" type="application/atom+xml" href="${escapeXml(feedUrl)}"/>\n` +
    `  <author>${text('name', feed.author)}</author>\n` +
    `  <generator uri="https://github.com/thinkhumandotdev/marmot">Marmot</generator>\n` +
    (entries ? `${entries}\n` : '') +
    `</feed>\n`
  )
}

export interface JsonFeedItem {
  id: string
  url: string
  title: string
  content_html: string
  date_published: string
  date_modified: string
}

export interface JsonFeed {
  version: 'https://jsonfeed.org/version/1.1'
  title: string
  home_page_url: string
  feed_url: string
  description: string
  language: string
  authors: { name: string }[]
  items: JsonFeedItem[]
}

/** The feed model as a JSON Feed 1.1 object. */
export function toJsonFeed(feed: StatusPageFeed, feedUrl: string): JsonFeed {
  return {
    version: 'https://jsonfeed.org/version/1.1',
    title: feed.title,
    home_page_url: feed.link,
    feed_url: feedUrl,
    description: feed.description,
    language: feed.language,
    authors: [{ name: feed.author }],
    items: feed.items.map((item) => ({
      id: item.id,
      url: item.url,
      title: item.title,
      content_html: item.html,
      date_published: item.published.toISOString(),
      date_modified: item.updated.toISOString(),
    })),
  }
}
