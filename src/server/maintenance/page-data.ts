import 'server-only'

import { notFound } from 'next/navigation'

import type { Maintenance } from '@/payload-types'
import { parseId, relationId } from '@/server/monitors/http'
import type { OrgPageContext } from '@/server/monitors/page-data'

export interface MonitorOption {
  id: string
  name: string
  type: string
  /** Group the monitor belongs to, for display. */
  parent: string | null
}

export interface StatusPageOption {
  id: string
  title: string
  slug: string
}

/** Loads a maintenance of the organization as the user (404 otherwise). */
export async function getOrgMaintenance(ctx: OrgPageContext, rawId: string): Promise<Maintenance> {
  const id = parseId(ctx.payload, rawId)
  let doc: Maintenance
  try {
    doc = await ctx.payload.findByID({
      collection: 'maintenance',
      id,
      depth: 0,
      user: ctx.requestUser,
      overrideAccess: false,
    })
  } catch {
    notFound()
  }
  if (String(relationId(doc.organization)) !== String(ctx.org.id)) notFound()
  return doc
}

/** Monitors of the organization for the "affected monitors" picker. */
export async function getOrgMonitorOptions(ctx: OrgPageContext): Promise<MonitorOption[]> {
  const { docs } = await ctx.payload.find({
    collection: 'monitors',
    where: { organization: { equals: ctx.org.id } },
    sort: 'name',
    limit: 0,
    pagination: false,
    depth: 0,
    user: ctx.requestUser,
    overrideAccess: false,
    disableErrors: true,
  })
  const names = new Map(docs.map((m) => [String(m.id), m.name]))
  return docs.map((m) => {
    const parentId = relationId(m.parent)
    return {
      id: String(m.id),
      name: m.name,
      type: m.type,
      parent: parentId === null ? null : (names.get(String(parentId)) ?? null),
    }
  })
}

/** Status pages of the organization for the "show on status pages" picker. */
export async function getOrgStatusPageOptions(ctx: OrgPageContext): Promise<StatusPageOption[]> {
  const { docs } = await ctx.payload.find({
    collection: 'status-pages',
    where: { organization: { equals: ctx.org.id } },
    sort: 'title',
    limit: 0,
    pagination: false,
    depth: 0,
    user: ctx.requestUser,
    overrideAccess: false,
    disableErrors: true,
  })
  return docs.map((p) => ({ id: String(p.id), title: p.title, slug: p.slug }))
}
