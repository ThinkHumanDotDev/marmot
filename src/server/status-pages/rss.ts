/**
 * RSS 2.0 feed of a status page: one item per incident update (newest first) and monitors that are
 * currently down.
 * Mirrors Uptime Kuma's `StatusPage.renderRSS` (MIT) with a hand-written XML builder instead of
 * the `feed` package.
 */
import type { Payload } from 'payload'

import { getStaticFormatter, getTranslator } from '@/i18n/translator'
import { renderMarkdown } from '@/lib/markdown'
import { eventPath } from '@/lib/status-page-events'
import type { Locale } from '@/i18n/locales'
import { resolveStatusPageLocale, statusPageTimeZone } from '@/i18n/resolve'
import type { Incident, StatusPage } from '@/payload-types'

import {
  buildPublicGroups,
  componentNamesOf,
  pageOverallStatus,
  toPublicIncident,
  type PublicIncident,
} from './public'

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

/** Newest items kept in the feed. */
export const MAX_FEED_ITEMS = 200

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

type Translator = ReturnType<typeof getTranslator>

/**
 * One item per update, linking to the incident's permalink: the opening update carries the incident
 * title, later ones are prefixed with their status (`[Resolved] Database failover`). The description is the update's Markdown plus the
 * components it affected.
 */
export function incidentUpdateItems(
  incident: PublicIncident,
  pageUrl: string,
  t: Translator,
): RssItem[] {
  const oldest = incident.updates.at(-1)?.id
  return incident.updates.map((update) => {
    const affected = update.components
      .map((c) =>
        t('statusPages.public.incidents.componentImpact', {
          name: c.name,
          impact: t(`statusPages.public.impact.${c.impact}`),
        }),
      )
      .join(', ')
    return {
      title:
        update.id === oldest
          ? incident.title
          : t('statusPages.public.incidents.feedTitle', {
              title: incident.title,
              status: t(`statusPages.public.incidents.status.${update.status}`),
            }),
      description:
        renderMarkdown(update.message) +
        (affected
          ? `<p>${escapeXml(t('statusPages.public.incidents.affected', { components: affected }))}</p>`
          : ''),
      link: `${pageUrl}${eventPath('incident', incident.publicId)}`,
      guid: `incident-${incident.id}-${update.id}`,
      pubDate: new Date(update.postedAt),
    }
  })
}

/**
 * Builds the feed for a published status page. `pageUrl` is the public URL of the page; the
 * text is rendered in `locale` (`statusPageFeedLocale`) with times in the organization's zone.
 */
export async function buildStatusPageRss(
  payload: Payload,
  page: StatusPage,
  pageUrl: string,
  locale: Locale = resolveStatusPageLocale(page, new Headers()),
): Promise<string> {
  const [groups, incidents] = await Promise.all([
    buildPublicGroups(payload, page),
    findFeedIncidents(payload, page.id),
  ])
  const t = getTranslator(locale)
  const format = getStaticFormatter(locale, statusPageTimeZone(page))

  const monitors = groups.flatMap((g) => g.monitors)
  const names = componentNamesOf(groups)
  const publicIncidents = incidents.map((incident) => toPublicIncident(incident, names))
  const overall = pageOverallStatus(
    groups,
    publicIncidents.filter((incident) => incident.active),
  )

  const items: RssItem[] = publicIncidents.flatMap((incident) =>
    incidentUpdateItems(incident, pageUrl, t),
  )

  for (const monitor of monitors) {
    if (monitor.status !== 'down') continue
    const since = monitor.beats.at(-1)?.time
    items.push({
      title: t('statusPages.rss.monitorDown', { name: monitor.name }),
      description: since
        ? t('statusPages.rss.monitorDownSince', {
            name: monitor.name,
            since: format.dateTime(new Date(since), 'zoned'),
          })
        : t('statusPages.rss.monitorDownDescription', { name: monitor.name }),
      link: pageUrl,
      guid: `monitor-${monitor.id}-${since ?? 'down'}`,
      pubDate: since ? new Date(since) : new Date(),
    })
  }

  items.sort((a, b) => b.pubDate.getTime() - a.pubDate.getTime())
  items.splice(MAX_FEED_ITEMS)

  return renderRss({
    title: t('statusPages.rss.title', { title: page.title }),
    description: t('statusPages.rss.description', { status: t(`statusPages.overall.${overall}`) }),
    link: pageUrl,
    language: locale,
    feedUrl: `${pageUrl}/rss`,
    items,
  })
}
