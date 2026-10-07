import {
  corsPreflight,
  jsonDocument,
  publicStatusPageRoute,
} from '@/server/status-pages/public-api'
import { buildScheduledMaintenances } from '@/server/status-pages/statuspage'

export const dynamic = 'force-dynamic'

/** GET /status/:slug/api/v2/scheduled-maintenances.json — Statuspage v2 compatible (see statuspage.ts). */
export const GET = publicStatusPageRoute(async (ctx) =>
  jsonDocument(await buildScheduledMaintenances(ctx)),
)

export const OPTIONS = corsPreflight
