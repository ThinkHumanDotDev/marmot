import { getPayload } from 'payload'

import config from '@payload-config'
import { FRAME_ANCESTORS_NONE, frameAncestorsFor } from '@/lib/status-page-embed'
import { findPublishedStatusPage } from '@/server/status-pages/public'

export const dynamic = 'force-dynamic'

/** Seconds the proxy (and any cache) may reuse a policy; switching embedding off takes this long. */
const EMBED_POLICY_MAX_AGE = 60

/**
 * GET /api/status-pages/:slug/embed-policy — `{ frameAncestors }`: the CSP `frame-ancestors` source
 * list of the page's HTML (#109). Used by `src/proxy.ts`, which cannot load the page itself. Unknown,
 * unpublished and protected pages answer `'none'`, so the policy fails closed.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const payload = await getPayload({ config })
  const page = /^[a-z0-9-]+$/i.test(slug) ? await findPublishedStatusPage(payload, slug) : null
  return Response.json(
    { frameAncestors: page ? frameAncestorsFor(page) : FRAME_ANCESTORS_NONE },
    { headers: { 'Cache-Control': `public, max-age=${EMBED_POLICY_MAX_AGE}` } },
  )
}
