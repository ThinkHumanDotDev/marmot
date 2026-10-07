import { isEventKind } from '@/lib/status-page-events'
import { getIncidentEvent, getMaintenanceEvent } from '@/server/status-pages/events'
import {
  renderIncidentMarkdown,
  renderMaintenanceMarkdown,
} from '@/server/status-pages/markdown-output'
import {
  corsPreflight,
  markdownDocument,
  notFoundProblem,
  servePublicStatusPage,
} from '@/server/status-pages/public-api'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ slug: string; kind: string; id: string }> }

/**
 * GET /status/:slug/event-md/:kind/:publicId — an incident or maintenance window as Markdown.
 * Public URL: its permalink plus `.md` (`/status/:slug/events/incident/:publicId.md`, or
 * `/events/<kind>/<publicId>.md` on custom domains), rewritten here by `src/proxy.ts` because the permalink
 * pages (#107) own `/events/[kind]/[id]`.
 */
export async function GET(request: Request, { params }: RouteContext) {
  const { slug, kind, id } = await params
  return servePublicStatusPage(request, slug, async ({ payload, page, links, locale }) => {
    if (!isEventKind(kind)) return notFoundProblem(request, 'statusPageEventNotFound')
    if (kind === 'incident') {
      const event = await getIncidentEvent(payload, page, id)
      if (!event) return notFoundProblem(request, 'statusPageEventNotFound')
      return markdownDocument(renderIncidentMarkdown(page, event.incident, links, locale))
    }
    const event = await getMaintenanceEvent(payload, page, id)
    if (!event) return notFoundProblem(request, 'statusPageEventNotFound')
    return markdownDocument(renderMaintenanceMarkdown(page, event.maintenance, links, locale))
  })
}

export const OPTIONS = corsPreflight
