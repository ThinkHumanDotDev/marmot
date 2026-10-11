import { getPayload } from 'payload'

import config from '@payload-config'
import { HOSTNAME_PATTERN, normalizeHostname } from '@/collections/StatusPages'
import { orgAllowsCustomDomains, relationId } from '@/server/billing/entitlements'

export const dynamic = 'force-dynamic'

/**
 * GET /api/status-pages/resolve-domain?host=status.example.com
 *
 * Maps a custom hostname to the slug of the published status page that lists it. Used by
 * `src/proxy.ts` to rewrite requests that arrive on a custom domain, and usable as Caddy's
 * `on_demand_tls { ask … }` endpoint (which sends `?domain=`). Returns `{ slug }` or 404 (also when
 * the organization's plan does not include custom domains).
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

  // A plan without custom domains (#161, e.g. after a downgrade) stops serving them; the page stays
  // reachable at /status/<slug> and the hostnames are kept for an upgrade.
  const page =
    docs[0] && (await orgAllowsCustomDomains(payload, relationId(docs[0].organization)))
      ? docs[0]
      : undefined
  if (!page) {
    return Response.json(
      { error: 'No status page for this host' },
      { status: 404, headers: { 'Cache-Control': 'public, max-age=60' } },
    )
  }
  return Response.json({ slug: page.slug }, { headers: { 'Cache-Control': 'public, max-age=60' } })
}
