import {
  corsPreflight,
  jsonDocument,
  publicStatusPageRoute,
} from '@/server/status-pages/public-api'
import { buildComponents } from '@/server/status-pages/statuspage'

export const dynamic = 'force-dynamic'

/** GET /status/:slug/api/v2/components.json — Statuspage v2 compatible (see statuspage.ts). */
export const GET = publicStatusPageRoute(async (ctx) => jsonDocument(await buildComponents(ctx)))

export const OPTIONS = corsPreflight
