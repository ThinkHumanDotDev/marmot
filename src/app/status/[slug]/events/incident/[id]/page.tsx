import type { Metadata } from 'next'
import { notFound } from 'next/navigation'

import { IncidentEventView } from '@/components/status-pages/public/event-detail'
import { eventPath } from '@/lib/status-page-events'
import { toPublicConfig } from '@/server/status-pages/public'

import { requireVisiblePage } from '../../../data'
import { StatusPageExtras } from '../../../extras'
import { eventMetadata, loadIncidentEvent } from '../../event-page'

export const dynamic = 'force-dynamic'

type PageProps = { params: Promise<{ slug: string; id: string }> }

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug, id } = await params
  return eventMetadata(slug, 'incident', id)
}

/** `/status/:slug/events/incident/:publicId`: the permalink of one incident. */
export default async function IncidentPermalink({ params }: PageProps) {
  const { slug, id } = await params
  const { page, basePath, restricted } = await requireVisiblePage(
    slug,
    eventPath('incident', id.toLowerCase()),
  )
  const event = await loadIncidentEvent(slug, id)
  if (!event) notFound()
  const config = toPublicConfig(page)

  return (
    <>
      <StatusPageExtras config={config} restricted={restricted} />
      <main id="status-page-event" data-slug={page.slug}>
        <IncidentEventView
          config={config}
          basePath={basePath}
          incident={event.incident}
          summary={event.summary}
          now={new Date().toISOString()}
        />
      </main>
    </>
  )
}
