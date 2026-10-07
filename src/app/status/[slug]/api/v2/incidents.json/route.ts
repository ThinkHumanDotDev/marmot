import {
  corsPreflight,
  jsonDocument,
  publicStatusPageRoute,
} from '@/server/status-pages/public-api'
import { buildIncidents } from '@/server/status-pages/statuspage'

export const dynamic = 'force-dynamic'

/** GET /status/:slug/api/v2/incidents.json — Statuspage v2 compatible (see statuspage.ts). */
export const GET = publicStatusPageRoute(async (ctx) => jsonDocument(await buildIncidents(ctx)))

export const OPTIONS = corsPreflight
