/**
 * RSS 2.0 feed of a status page: incidents (newest first) and monitors that are currently down.
 * Mirrors Uptime Kuma's `StatusPage.renderRSS` (MIT) with a hand-written XML builder instead of
 * the `feed` package.
 */
import type { Payload } from 'payload'

import type { Incident, StatusPage } from '@/payload-types'

import { renderMarkdown } from '@/lib/markdown'

import { buildPublicGroups, overallStatus, STATUS_DESCRIPTIONS } from './public'

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
    `    <language>en</language>\n` +
    `    ${element('lastBuildDate', (channel.lastBuildDate ?? new Date()).toUTCString())}\n` +
    `    <atom:link href="${escapeXml(channel.feedUrl)}" rel="self" type="application/rss+xml"/>\n` +
    (items ? `${items}\n` : '') +
    `  </channel>\n` +
    `</rss>\n`
  )
}

/** All incidents of a page (active and resolved), newest first. */
export async function findFeedIncidents(
  payload: Payload,
  pageId: string | number,
  limit = 50,
): Promise<Incident[]> {
  const { docs } = await payload.find({
    collection: 'incidents',
    where: { statusPage: { equals: pageId } },
    sort: '-createdAt',
    limit,
    pagination: false,
    depth: 0,
    overrideAccess: true,
  })
  return docs
}

/** Builds the feed for a published status page. `pageUrl` is the public URL of the page. */
export async function buildStatusPageRss(
  payload: Payload,
  page: StatusPage,
  pageUrl: string,
): Promise<string> {
  const [groups, incidents] = await Promise.all([
    buildPublicGroups(payload, page),
    findFeedIncidents(payload, page.id),
  ])

  const monitors = groups.flatMap((g) => g.monitors)
  const overall = overallStatus(monitors.map((m) => m.status))

  const items: RssItem[] = incidents.map((incident) => ({
    title: incident.active === false ? `[Resolved] ${incident.title}` : incident.title,
    description: renderMarkdown(incident.content ?? ''),
    link: pageUrl,
    guid: `incident-${incident.id}-${incident.updatedAt}`,
    pubDate: new Date(incident.updatedAt ?? incident.createdAt),
  }))

  for (const monitor of monitors) {
    if (monitor.status !== 'down') continue
    const since = monitor.beats.at(-1)?.time
    items.push({
      title: `${monitor.name} is down`,
      description: since
        ? `${monitor.name} has been down since ${new Date(since).toUTCString()}.`
        : `${monitor.name} is down.`,
      link: pageUrl,
      guid: `monitor-${monitor.id}-${since ?? 'down'}`,
      pubDate: since ? new Date(since) : new Date(),
    })
  }

  items.sort((a, b) => b.pubDate.getTime() - a.pubDate.getTime())

  return renderRss({
    title: `${page.title} status`,
    description: `Current status: ${STATUS_DESCRIPTIONS[overall]}`,
    link: pageUrl,
    feedUrl: `${pageUrl}/rss`,
    items,
  })
}
