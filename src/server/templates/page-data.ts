import 'server-only'

import { componentDisplayName } from '@/lib/status-page-components'
import { toTemplateRow, type TemplateKind, type TemplateRow } from '@/lib/templates'
import type { StatusPage } from '@/payload-types'
import { relationId } from '@/server/monitors/http'
import type { OrgPageContext } from '@/server/monitors/page-data'

/** A status page and its components, for the template form's "default components" editor. */
export interface TemplatePageOption {
  id: string
  title: string
  components: { id: string; name: string }[]
}

/** Templates of the organization the user may read, by name; optionally only some kinds. */
export async function getOrgTemplates(
  ctx: OrgPageContext,
  kinds?: TemplateKind[],
): Promise<TemplateRow[]> {
  const { docs } = await ctx.payload.find({
    collection: 'templates',
    where: {
      and: [{ organization: { equals: ctx.org.id } }, ...(kinds ? [{ kind: { in: kinds } }] : [])],
    },
    sort: 'name',
    limit: 0,
    pagination: false,
    depth: 0,
    user: ctx.requestUser,
    overrideAccess: false,
    disableErrors: true,
  })
  return docs.map((doc) => toTemplateRow(doc))
}

/** Status pages of the organization with their components (group rows) in display order. */
export async function getTemplatePageOptions(ctx: OrgPageContext): Promise<TemplatePageOption[]> {
  const common = {
    where: { organization: { equals: ctx.org.id } },
    limit: 0,
    pagination: false,
    depth: 0,
    user: ctx.requestUser,
    overrideAccess: false,
    disableErrors: true,
  } as const
  const [pages, monitors] = await Promise.all([
    ctx.payload.find({ collection: 'status-pages', sort: 'title', ...common }),
    ctx.payload.find({
      collection: 'monitors',
      select: { name: true, publicName: true },
      ...common,
    }),
  ])
  const byId = new Map(monitors.docs.map((m) => [String(m.id), m]))
  return (pages.docs as StatusPage[]).map((page) => ({
    id: String(page.id),
    title: page.title,
    components: (page.groups ?? []).flatMap((group) =>
      (group.monitors ?? []).flatMap((row) => {
        if (!row.id) return []
        const monitorId = row.type === 'static' ? null : relationId(row.monitor)
        const monitor = monitorId === null ? null : byId.get(String(monitorId))
        const name = componentDisplayName(row.name, monitor) || `${group.name} #${row.id.slice(-4)}`
        return [{ id: row.id, name }]
      }),
    ),
  }))
}
