import { coerceId } from '@/server/status-pages/http'
import { renderIncidentMarkdown } from '@/server/status-pages/markdown-output'
import { buildPublicGroups, componentNamesOf } from '@/server/status-pages/public'
import {
  corsPreflight,
  markdownDocument,
  notFoundProblem,
  servePublicStatusPage,
} from '@/server/status-pages/public-api'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ slug: string; id: string }> }

/**
 * GET /status/:slug/incident-md/:id — one incident as Markdown. Public URL:
 * `/status/:slug/incidents/:id.md` (`/incidents/:id.md` on custom domains), rewritten here by
 * `src/proxy.ts` so the incident permalink pages can own `/incidents/[id]`.
 */
export async function GET(request: Request, { params }: RouteContext) {
  const { slug, id } = await params
  return servePublicStatusPage(request, slug, async ({ payload, page, links, locale }) => {
    const incident = await payload
      .find({
        collection: 'incidents',
        where: {
          and: [{ id: { equals: coerceId(payload, id) } }, { statusPage: { equals: page.id } }],
        },
        limit: 1,
        depth: 0,
        pagination: false,
        overrideAccess: true,
      })
      // Ids of the wrong shape for the database (`abc` on Postgres) are simply unknown.
      .then(({ docs }) => docs[0] ?? null)
      .catch(() => null)
    if (!incident) return notFoundProblem(request, 'incidentNotFound')
    const names = componentNamesOf(await buildPublicGroups(payload, page))
    return markdownDocument(renderIncidentMarkdown(page, incident, names, links, locale))
  })
}

export const OPTIONS = corsPreflight
