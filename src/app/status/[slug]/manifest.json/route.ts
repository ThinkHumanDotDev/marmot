import { getPayload } from 'payload'

import config from '@payload-config'
import { findPublishedStatusPage, toPublicConfig } from '@/server/status-pages/public'
import { statusPagePath } from '@/server/status-pages/urls'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ slug: string }> }

/** GET /status/:slug/manifest.json — web app manifest so the page can be installed. */
export async function GET(_request: Request, { params }: RouteContext) {
  const { slug } = await params
  const payload = await getPayload({ config })
  const page = await findPublishedStatusPage(payload, slug)
  if (!page) return Response.json({ error: 'Not found' }, { status: 404 })

  const { logo, title, description } = toPublicConfig(page)
  const logoDoc = page.logo && typeof page.logo === 'object' ? page.logo : null

  return Response.json(
    {
      name: title,
      short_name: title.length > 12 ? title.slice(0, 12) : title,
      description: description ?? undefined,
      start_url: statusPagePath(page.slug),
      display: 'standalone',
      background_color: '#f7f5f1',
      theme_color: '#f7f5f1',
      icons: logo
        ? [
            {
              src: logo,
              sizes:
                logoDoc?.width && logoDoc?.height ? `${logoDoc.width}x${logoDoc.height}` : 'any',
              type: logoDoc?.mimeType ?? undefined,
            },
          ]
        : [],
    },
    {
      headers: {
        'Content-Type': 'application/manifest+json; charset=utf-8',
        'Cache-Control': 'public, max-age=3600',
      },
    },
  )
}
