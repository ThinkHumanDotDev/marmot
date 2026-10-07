/**
 * The feed model shared by the RSS 2.0, Atom 1.0 and JSON Feed 1.1 renderers of a status page: one
 * item per incident update (newest first, linked to the incident permalink) and one per monitor that is
 * currently down. Every renderer serialises the same items, so the three feeds always agree.
 *
 * Item ids are stable: an update keeps its id when its text is edited (`updated` moves instead), and
 * a down monitor is identified by the start of its current down streak.
 */
import type { Payload } from 'payload'

import { getStaticFormatter, getTranslator } from '@/i18n/translator'
import type { Locale } from '@/i18n/locales'
import { resolveStatusPageLocale, statusPageTimeZone } from '@/i18n/resolve'
import { escapeHtml, renderMarkdown } from '@/lib/markdown'
import type { Incident, StatusPage } from '@/payload-types'

import {
  buildPublicGroups,
  componentNamesOf,
  pageOverallStatus,
  toPublicIncident,
  type OverallStatus,
  type PublicBeat,
  type PublicIncident,
} from './public'
import { incidentPermalink, serverUrl } from './urls'

/** Newest items kept in the feed. */
export const MAX_FEED_ITEMS = 200

export interface FeedItem {
  /** RSS `guid` (unchanged since the RSS feed shipped, so readers do not see duplicates). */
  guid: string
  /** Globally unique, stable IRI (`tag:` URI) for Atom `id` and JSON Feed `id`. */
  id: string
  title: string
  /** HTML body. */
  html: string
  /** Permalink (the incident page, or the status page for monitors). */
  url: string
  published: Date
  /** Last edit of the text; equals `published` when never edited. */
  updated: Date
}

export interface StatusPageFeed {
  title: string
  description: string
  /** Public URL of the status page. */
  link: string
  /** BCP 47 language of the text. */
  language: string
  /** Newest `updated` of the items, or the page's last change. */
  updated: Date
  /** Feed-level IRI (`tag:` URI of the page). */
  id: string
  /** Author shown by Atom readers (the page title). */
  author: string
  overall: OverallStatus
  items: FeedItem[]
}

type Translator = ReturnType<typeof getTranslator>

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

/**
 * `tag:` URI (RFC 4151) for a page: `tag:<server host>,<page creation date>:status-page/<id>`.
 * Independent of the domain the feed was fetched on, so the main host and a custom domain agree.
 */
export function feedTagUri(
  page: { id: string | number; createdAt: string },
  ...path: string[]
): string {
  let host = 'marmot.invalid'
  try {
    host = new URL(serverUrl()).hostname || host
  } catch {
    // keep the placeholder
  }
  const date = (page.createdAt ?? '').slice(0, 10) || '2026-01-01'
  const segments = ['status-page', String(page.id), ...path].map((s) =>
    encodeURIComponent(s).replace(/%2F/gi, '-'),
  )
  return `tag:${host},${date}:${segments.join('/')}`
}

/**
 * One item per update: the opening update carries the incident title, later ones are prefixed with
 * their status (`[Resolved] Database failover`). The description is the update's Markdown plus the
 * components it affected.
 */
export function incidentUpdateItems(
  incident: PublicIncident,
  pageUrl: string,
  t: Translator,
  page: { id: string | number; createdAt: string } = { id: 'page', createdAt: '' },
): FeedItem[] {
  const oldest = incident.updates.at(-1)?.id
  const url = incidentPermalink(pageUrl, incident.id)
  return incident.updates.map((update) => {
    const affected = update.components
      .map((c) =>
        t('statusPages.public.incidents.componentImpact', {
          name: c.name,
          impact: t(`statusPages.public.impact.${c.impact}`),
        }),
      )
      .join(', ')
    const published = new Date(update.postedAt)
    return {
      guid: `incident-${incident.id}-${update.id}`,
      id: feedTagUri(page, 'incident', incident.id, 'update', update.id),
      title:
        update.id === oldest
          ? incident.title
          : t('statusPages.public.incidents.feedTitle', {
              title: incident.title,
              status: t(`statusPages.public.incidents.status.${update.status}`),
            }),
      html:
        renderMarkdown(update.message) +
        (affected
          ? `<p>${escapeHtml(t('statusPages.public.incidents.affected', { components: affected }))}</p>`
          : ''),
      url,
      published,
      updated: update.editedAt ? new Date(update.editedAt) : published,
    }
  })
}

/**
 * Start of the trailing run of `status` beats (oldest first), i.e. since when a monitor has been in
 * its current state as far as the recent beats tell; null without beats in that state.
 */
export function statusSince(beats: readonly PublicBeat[], status: string): string | null {
  let since: string | null = null
  for (let i = beats.length - 1; i >= 0; i--) {
    if (beats[i].status !== status) break
    since = beats[i].time
  }
  return since
}

/**
 * Builds the feed model of a published status page. `pageUrl` is the public URL of the page (main
 * host or custom domain); the text is rendered in `locale` with times in the organization's zone.
 */
export async function buildStatusPageFeed(
  payload: Payload,
  page: StatusPage,
  pageUrl: string,
  locale: Locale = resolveStatusPageLocale(page, new Headers()),
): Promise<StatusPageFeed> {
  const [groups, incidents] = await Promise.all([
    buildPublicGroups(payload, page),
    findFeedIncidents(payload, page.id),
  ])
  const t = getTranslator(locale)
  const format = getStaticFormatter(locale, statusPageTimeZone(page))

  const names = componentNamesOf(groups)
  const publicIncidents = incidents.map((incident) => toPublicIncident(incident, names))
  const overall = pageOverallStatus(
    groups,
    publicIncidents.filter((incident) => incident.active),
  )

  const items: FeedItem[] = publicIncidents.flatMap((incident) =>
    incidentUpdateItems(incident, pageUrl, t, page),
  )

  for (const monitor of groups.flatMap((g) => g.monitors)) {
    if (monitor.status !== 'down') continue
    const since = statusSince(monitor.beats, 'down')
    const published = since ? new Date(since) : new Date(page.updatedAt)
    items.push({
      guid: `monitor-${monitor.id}-${since ?? 'down'}`,
      id: feedTagUri(page, 'monitor', monitor.id, 'down', since ?? 'unknown'),
      title: t('statusPages.rss.monitorDown', { name: monitor.name }),
      html: escapeHtml(
        since
          ? t('statusPages.rss.monitorDownSince', {
              name: monitor.name,
              since: format.dateTime(new Date(since), 'zoned'),
            })
          : t('statusPages.rss.monitorDownDescription', { name: monitor.name }),
      ),
      url: pageUrl,
      published,
      updated: published,
    })
  }

  items.sort((a, b) => b.published.getTime() - a.published.getTime())
  items.splice(MAX_FEED_ITEMS)

  const newest = Math.max(
    Date.parse(page.updatedAt) || 0,
    ...items.map((item) => item.updated.getTime()),
  )

  return {
    title: t('statusPages.rss.title', { title: page.title }),
    description: t('statusPages.rss.description', { status: t(`statusPages.overall.${overall}`) }),
    link: pageUrl,
    language: locale,
    updated: new Date(newest || Date.now()),
    id: feedTagUri(page),
    author: page.title,
    overall,
    items,
  }
}
