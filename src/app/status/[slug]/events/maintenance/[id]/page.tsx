import type { Metadata } from 'next'
import { notFound } from 'next/navigation'

import { MaintenanceEventView } from '@/components/status-pages/public/event-detail'
import { eventPath } from '@/lib/status-page-events'
import { toPublicConfig } from '@/server/status-pages/public'

import { requireVisiblePage } from '../../../data'
import { StatusPageExtras } from '../../../extras'
import { eventMetadata, loadMaintenanceEvent } from '../../event-page'

export const dynamic = 'force-dynamic'

type PageProps = { params: Promise<{ slug: string; id: string }> }

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug, id } = await params
  return eventMetadata(slug, 'maintenance', id)
}

/** `/status/:slug/events/maintenance/:publicId`: the permalink of one maintenance window. */
export default async function MaintenancePermalink({ params }: PageProps) {
  const { slug, id } = await params
  const { page, basePath, restricted } = await requireVisiblePage(
    slug,
    eventPath('maintenance', id.toLowerCase()),
  )
  const event = await loadMaintenanceEvent(slug, id)
  if (!event) notFound()
  const config = toPublicConfig(page)

  return (
    <>
      <StatusPageExtras config={config} restricted={restricted} />
      <main id="status-page-event" data-slug={page.slug}>
        <MaintenanceEventView
          config={config}
          basePath={basePath}
          maintenance={event.maintenance}
          summary={event.summary}
          now={new Date().toISOString()}
        />
      </main>
    </>
  )
}
