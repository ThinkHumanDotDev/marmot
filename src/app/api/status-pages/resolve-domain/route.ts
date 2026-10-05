import { getPayload } from 'payload'

import config from '@payload-config'
import { HOSTNAME_PATTERN, normalizeHostname } from '@/collections/StatusPages'

export const dynamic = 'force-dynamic'

/**
 * GET /api/status-pages/resolve-domain?host=status.example.com
 *
 * Maps a custom hostname to the slug of the published status page that lists it. Used by
 * `src/proxy.ts` to rewrite requests that arrive on a custom domain, and usable as Caddy's
 * `on_demand_tls { ask … }` endpoint (which sends `?domain=`). Returns `{ slug }` or 404.
 */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams
  const raw = params.get('host') ?? params.get('domain') ?? ''
  const host = normalizeHostname(raw)
  if (!HOSTNAME_PATTERN.test(host)) {
    return Response.json({ error: 'Invalid host' }, { status: 400 })
  }

  const payload = await getPayload({ config })
  const { docs } = await payload.find({
    collection: 'status-pages',
    where: { and: [{ 'domains.hostname': { equals: host } }, { published: { equals: true } }] },
    depth: 0,
    limit: 1,
    pagination: false,
    overrideAccess: true,
  })

  const page = docs[0]
  if (!page) {
    return Response.json(
      { error: 'No status page for this host' },
      { status: 404, headers: { 'Cache-Control': 'public, max-age=60' } },
    )
  }
  return Response.json({ slug: page.slug }, { headers: { 'Cache-Control': 'public, max-age=60' } })
}
