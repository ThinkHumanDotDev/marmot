/** Choices for the rule editor of Settings → Integrations (#152), loaded as the member. */
import type { IntegrationChoices } from '@/lib/inbound-alerts'
import { componentDisplayName } from '@/lib/status-page-components'
import type { Monitor, StatusPage } from '@/payload-types'
import type { OrgPageContext } from '@/server/monitors/page-data'

const relKey = (value: unknown): string | null => {
  if (value === null || value === undefined) return null
  if (typeof value === 'object') return 'id' in value ? String((value as { id: unknown }).id) : null
  return String(value)
}

export async function integrationChoices(ctx: OrgPageContext): Promise<IntegrationChoices> {
  const [pages, monitors] = await Promise.all([
    ctx.payload.find({
      collection: 'status-pages',
      where: { organization: { equals: ctx.org.id } },
      sort: 'title',
      depth: 0,
      limit: 200,
      user: ctx.requestUser,
      overrideAccess: false,
    }),
    ctx.payload.find({
      collection: 'monitors',
      where: { organization: { equals: ctx.org.id } },
      sort: 'name',
      depth: 0,
      limit: 1000,
      user: ctx.requestUser,
      overrideAccess: false,
      select: { name: true, publicName: true, type: true },
    }),
  ])
  const monitorDocs = monitors.docs as Pick<Monitor, 'id' | 'name' | 'publicName' | 'type'>[]
  const byId = new Map(monitorDocs.map((monitor) => [String(monitor.id), monitor]))
  return {
    statusPages: (pages.docs as StatusPage[]).map((page) => ({
      id: String(page.id),
      title: page.title,
      components: (page.groups ?? []).flatMap((group) =>
        (group.monitors ?? []).flatMap((row) => {
          if (!row.id) return []
          const monitorId = relKey(row.monitor)
          const name =
            componentDisplayName(row.name, monitorId ? byId.get(monitorId) : null) || row.id
          return [{ id: String(row.id), name: group.name ? `${group.name} / ${name}` : name }]
        }),
      ),
    })),
    pushMonitors: monitorDocs
      .filter((monitor) => monitor.type === 'push')
      .map((monitor) => ({ id: String(monitor.id), name: monitor.name })),
  }
}
