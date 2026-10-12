import { getPayload } from 'payload'

import config from '@payload-config'
import { serveStatusWidget } from '@/server/status-pages/widget'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ slug: string }> }

/**
 * GET /status/:slug/widget.js — the embeddable status widget of a public page (#109,
 * `data-theme`, `data-size`). See `src/server/status-pages/widget.ts` and docs/Status-Pages.md.
 */
export async function GET(request: Request, { params }: RouteContext) {
  const { slug } = await params
  const payload = await getPayload({ config })
  return serveStatusWidget(payload, request, slug)
}
