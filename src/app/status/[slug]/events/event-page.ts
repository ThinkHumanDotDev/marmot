import 'server-only'

import type { Metadata } from 'next'
import { headers } from 'next/headers'
import { getTranslations } from 'next-intl/server'
import { getPayload } from 'payload'
import { cache } from 'react'

import config from '@payload-config'
import { getStatusPageLocale, statusPageTimeZone } from '@/i18n/server'
import { getStaticFormatter } from '@/i18n/translator'
import { markdownToText } from '@/lib/markdown'
import { eventPath, type EventKind } from '@/lib/status-page-events'
import { isProtectedPage } from '@/server/status-pages/access'
import {
  getIncidentEvent,
  getMaintenanceEvent,
  type PublicIncidentEvent,
  type PublicMaintenanceEvent,
} from '@/server/status-pages/events'
import { NOINDEX, statusPageMetadata, truncateDescription } from '@/server/status-pages/seo'
import { statusPageUrlForHeaders } from '@/server/status-pages/urls'

import { loadPageAccess, loadPublishedPage } from '../data'

/** The incident of the published page `slug` with this public id, memoised per request. */
export const loadIncidentEvent = cache(
  async (slug: string, publicId: string): Promise<PublicIncidentEvent | null> => {
    const page = await loadPublishedPage(slug)
    if (!page) return null
    return getIncidentEvent(await getPayload({ config }), page, publicId)
  },
)

/** The public maintenance window of the published page `slug`, memoised per request. */
export const loadMaintenanceEvent = cache(
  async (slug: string, publicId: string): Promise<PublicMaintenanceEvent | null> => {
    const page = await loadPublishedPage(slug)
    if (!page) return null
    return getMaintenanceEvent(await getPayload({ config }), page, publicId)
  },
)

/**
 * Metadata of a permalink: `{title} · {siteName}`, the latest update (else a templated summary)
 * as description, Open Graph `article` and the page's robots setting. Without access to a
 * protected page only the page title is revealed.
 */
export async function eventMetadata(
  slug: string,
  kind: EventKind,
  publicId: string,
): Promise<Metadata> {
  const page = await loadPublishedPage(slug)
  const locale = await getStatusPageLocale(page)
  const notFound = async () => {
    const t = await getTranslations({ locale, namespace: 'statusPages.notFound' })
    return { title: t('pageTitle'), robots: NOINDEX }
  }
  if (!page) return notFound()
  if (isProtectedPage(page) && !(await loadPageAccess(slug))?.allowed) {
    return { title: page.title, robots: NOINDEX }
  }
  const event =
    kind === 'incident'
      ? await loadIncidentEvent(slug, publicId)
      : await loadMaintenanceEvent(slug, publicId)
  if (!event) return notFound()

  const { summary } = event
  const t = await getTranslations({ locale, namespace: 'statusPages' })
  const format = getStaticFormatter(locale, statusPageTimeZone(page))
  const status =
    summary.kind === 'incident'
      ? t(`public.incidents.status.${summary.status as 'investigating'}`)
      : t(`public.maintenance.state.${summary.status as 'scheduled'}`)
  const dateRange = summary.end
    ? format.dateTimeRange(new Date(summary.start), new Date(summary.end), 'date')
    : format.dateTime(new Date(summary.start), 'date')
  const latest = summary.latest?.message ? markdownToText(summary.latest.message, 400) : ''
  const values = { title: summary.title, siteName: page.title, status, dateRange }
  const description = latest
    ? truncateDescription(latest)
    : kind === 'incident'
      ? t('seo.incidentDescription', values)
      : t('seo.maintenanceDescription', values)

  const base = statusPageUrlForHeaders(page, await headers())
  return statusPageMetadata(page, {
    title: kind === 'incident' ? t('seo.incidentTitle', values) : t('seo.maintenanceTitle', values),
    description,
    url: `${base}${eventPath(kind, summary.publicId)}`,
    type: 'article',
    publishedTime: summary.start,
    modifiedTime: summary.latest?.postedAt ?? summary.end ?? summary.start,
  })
}
