import { getPayload } from 'payload'

import config from '@payload-config'
import {
  accessCacheControl,
  accessDeniedResponse,
  accessRequestFrom,
  checkStatusPageAccess,
} from '@/server/status-pages/access'
import { findPublishedStatusPage, toPublicConfig } from '@/server/status-pages/public'
import { statusPagePath } from '@/server/status-pages/urls'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ slug: string }> }

/**
 * GET /status/:slug/manifest.json — web app manifest so the page can be installed. Password-protected
 * pages need the access cookie (the page links it with `crossorigin="use-credentials"`) or `?pw=`.
 */
export async function GET(request: Request, { params }: RouteContext) {
  const { slug } = await params
  const payload = await getPayload({ config })
  const page = await findPublishedStatusPage(payload, slug)
  if (!page) return Response.json({ error: 'Not found' }, { status: 404 })

  const access = await checkStatusPageAccess(payload, page, accessRequestFrom(request))
  if (!access.allowed) return accessDeniedResponse(access)

  const { title, description } = toPublicConfig(page)
  const media = [page.logo, page.favicon].flatMap((doc) =>
    doc && typeof doc === 'object' && doc.url ? [doc] : [],
  )

  return Response.json(
    {
      name: title,
      short_name: title.length > 12 ? title.slice(0, 12) : title,
      description: description ?? undefined,
      start_url: statusPagePath(page.slug),
      display: 'standalone',
      background_color: '#f7f5f1',
      theme_color: '#f7f5f1',
      // The logo, then the favicon (when set).
      icons: media.map((doc) => ({
        src: doc.url,
        sizes: doc.width && doc.height ? `${doc.width}x${doc.height}` : 'any',
        type: doc.mimeType ?? undefined,
      })),
    },
    {
      headers: {
        'Content-Type': 'application/manifest+json; charset=utf-8',
        'Cache-Control': accessCacheControl(access, 'public, max-age=3600'),
      },
    },
  )
}
