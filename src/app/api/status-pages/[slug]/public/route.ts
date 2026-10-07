import { getPayload } from 'payload'

import config from '@payload-config'
import {
  accessCacheControl,
  accessDeniedResponse,
  accessRequestFrom,
  checkStatusPageAccess,
} from '@/server/status-pages/access'
import { buildPublicStatusPageData, findPublishedStatusPage } from '@/server/status-pages/public'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ slug: string }> }

/**
 * GET /api/status-pages/:slug/public
 *
 * Anonymous. Returns `{ config, overall, groups, incidents, maintenance, generatedAt }` for a
 * published status page (see `src/server/status-pages/public.ts`), 404 otherwise. Cached for 30 s
 * by browsers and shared caches; the page's client refresh polls this endpoint.
 *
 * Password-protected pages answer 401 without the page's access cookie or a correct `?pw=`
 * (429 while rate limited) and are never cached by shared caches.
 */
export async function GET(request: Request, { params }: RouteContext) {
  const { slug } = await params
  const payload = await getPayload({ config })
  const page = await findPublishedStatusPage(payload, slug)

  if (!page) {
    return Response.json(
      { error: 'Status page not found' },
      { status: 404, headers: { 'Cache-Control': 'no-store' } },
    )
  }

  const access = await checkStatusPageAccess(payload, page, accessRequestFrom(request))
  if (!access.allowed) return accessDeniedResponse(access)

  const data = await buildPublicStatusPageData(payload, page)
  return Response.json(data, {
    headers: {
      'Cache-Control': accessCacheControl(access, 'public, max-age=30'),
      ...(access.restricted ? { 'X-Robots-Tag': 'noindex, nofollow' } : {}),
    },
  })
}
