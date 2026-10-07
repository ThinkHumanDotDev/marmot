import type { Metadata } from 'next'
import { headers } from 'next/headers'
import { getPayload } from 'payload'
import { getTranslations } from 'next-intl/server'
import { cache } from 'react'

import config from '@payload-config'
import { EventHistoryView } from '@/components/status-pages/public/event-history-view'
import { getStatusPageLocale, statusPageTimeZone } from '@/i18n/server'
import { getStaticFormatter } from '@/i18n/translator'
import { EVENTS_PATH, eventFiltersQuery, parseEventFilters } from '@/lib/status-page-events'
import { isProtectedPage } from '@/server/status-pages/access'
import { monthKey } from '@/server/status-pages/event-summary'
import { listStatusPageEvents, type EventHistory } from '@/server/status-pages/events'
import { toPublicConfig } from '@/server/status-pages/public'
import { isIndexable, NOINDEX, statusPageMetadata } from '@/server/status-pages/seo'
import { statusPageUrlForHeaders } from '@/server/status-pages/urls'
import type { StatusPage } from '@/payload-types'

import { loadPageAccess, loadPublishedPage, requireVisiblePage } from '../data'
import { StatusPageExtras } from '../extras'

export const dynamic = 'force-dynamic'

type SearchParams = Record<string, string | string[] | undefined>
type PageProps = { params: Promise<{ slug: string }>; searchParams: Promise<SearchParams> }

/** The history for these filters, memoised per request (metadata and page share it). */
const loadHistoryFor = cache(async (slug: string, query: string): Promise<EventHistory | null> => {
  const page = await loadPublishedPage(slug)
  if (!page) return null
  const payload = await getPayload({ config })
  return listStatusPageEvents(payload, page, parseEventFilters(new URLSearchParams(query)))
})

const loadHistory = async (page: StatusPage, searchParams: SearchParams): Promise<EventHistory> =>
  (await loadHistoryFor(
    page.slug,
    eventFiltersQuery(parseEventFilters(searchParams)),
  )) as EventHistory

export async function generateMetadata({ params, searchParams }: PageProps): Promise<Metadata> {
  const { slug } = await params
  const page = await loadPublishedPage(slug)
  const locale = await getStatusPageLocale(page)
  if (!page) {
    const t = await getTranslations({ locale, namespace: 'statusPages.notFound' })
    return { title: t('pageTitle'), robots: NOINDEX }
  }
  if (isProtectedPage(page) && !(await loadPageAccess(slug))?.allowed) {
    return { title: page.title, robots: NOINDEX }
  }

  const t = await getTranslations({ locale, namespace: 'statusPages.seo' })
  const history = await loadHistory(page, await searchParams)
  const format = getStaticFormatter(locale, statusPageTimeZone(page))
  const dateRange = history.range
    ? format.dateTimeRange(new Date(history.range.from), new Date(history.range.to), 'date')
    : null
  const query = eventFiltersQuery(history.filters)
  const base = statusPageUrlForHeaders(page, await headers())
  const metadata = statusPageMetadata(page, {
    title: t('historyTitle', { siteName: page.title }),
    description: dateRange
      ? t('historyDescription', { siteName: page.title, dateRange })
      : t('historyDescriptionEmpty', { siteName: page.title }),
    url: `${base}${EVENTS_PATH}${query ? `?${query}` : ''}`,
  })
  // Filtered and paginated views are not indexed themselves; crawlers follow their links.
  return query && isIndexable(page)
    ? { ...metadata, robots: { index: false, follow: true } }
    : metadata
}

/** `/status/:slug/events` (and `/events` on custom domains): the page's event history. */
export default async function StatusPageHistory({ params, searchParams }: PageProps) {
  const { slug } = await params
  const { page, basePath, restricted } = await requireVisiblePage(slug, EVENTS_PATH)
  const history = await loadHistory(page, await searchParams)
  const timeZone = statusPageTimeZone(page)
  const monthOf = Object.fromEntries(
    history.events.map((event) => [
      `${event.kind}:${event.publicId}`,
      monthKey(event.start, timeZone),
    ]),
  )
  const publicConfig = toPublicConfig(page)

  return (
    <>
      <StatusPageExtras config={publicConfig} restricted={restricted} />
      <main id="status-page-history" data-slug={page.slug}>
        <EventHistoryView
          config={publicConfig}
          basePath={basePath}
          history={history}
          monthOf={monthOf}
        />
      </main>
    </>
  )
}
