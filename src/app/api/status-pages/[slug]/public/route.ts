import { getPayload } from 'payload'

import config from '@payload-config'
import { getPublicStatusPageData } from '@/server/status-pages/public'
import { errorText } from '@/server/request-locale'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ slug: string }> }

/**
 * GET /api/status-pages/:slug/public
 *
 * Anonymous. Returns `{ config, overall, groups, incidents, maintenance, generatedAt }` for a
 * published status page (see `src/server/status-pages/public.ts`), 404 otherwise. Cached for 30 s
 * by browsers and shared caches; the page's client refresh polls this endpoint.
 */
export async function GET(request: Request, { params }: RouteContext) {
  const { slug } = await params
  const payload = await getPayload({ config })
  const data = await getPublicStatusPageData(payload, slug)

  if (!data) {
    return Response.json(
      { error: errorText(request, 'statusPageNotFound') },
      { status: 404, headers: { 'Cache-Control': 'no-store' } },
    )
  }

  return Response.json(data, {
    headers: { 'Cache-Control': 'public, max-age=30' },
  })
}
