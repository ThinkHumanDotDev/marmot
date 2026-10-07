import { getPayload } from 'payload'

import config from '@payload-config'
import { serveStatusPageBadge } from '@/server/status-pages/badge'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ slug: string }> }

/**
 * GET /status/:slug/badge.svg — overall status of the page as an SVG badge (`?theme=`, `size=`,
 * `variant=`, `style=`, `label=`). See `src/server/status-pages/badge.ts` and docs/Status-Pages.md.
 */
export async function GET(request: Request, { params }: RouteContext) {
  const { slug } = await params
  const payload = await getPayload({ config })
  return serveStatusPageBadge(payload, request, slug)
}
