import { renderMaintenanceCalendar } from '@/server/status-pages/ical'
import { listMaintenanceEvents } from '@/server/status-pages/maintenance-events'
import { corsPreflight, publicStatusPageRoute } from '@/server/status-pages/public-api'

export const dynamic = 'force-dynamic'

/** GET /status/:slug/maintenance.ics — iCalendar feed of recent and upcoming maintenance. */
export const GET = publicStatusPageRoute(async ({ payload, page, links, locale }) => {
  const events = await listMaintenanceEvents(payload, page.id)
  return {
    body: renderMaintenanceCalendar({ page, pageUrl: links.page, locale, events }),
    contentType: 'text/calendar; charset=utf-8',
  }
})

export const OPTIONS = corsPreflight
