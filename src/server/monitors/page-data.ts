import 'server-only'

import { notFound } from 'next/navigation'
import { getPayload, type Payload } from 'payload'

import config from '@payload-config'
import { canWithOverrides, type Permission } from '@/access/permissions'
import { requireUser, type CurrentUser } from '@/lib/auth'
import type { Monitor, Organization } from '@/payload-types'
import { parseId, relationId, type RequestUser } from '@/server/monitors/http'
import { findOrganizationBySlug } from '@/server/organizations/resolve'

export interface OrgPageContext {
  payload: Payload
  user: CurrentUser
  requestUser: RequestUser
  org: Organization
  /** `canWithOverrides(user, org, permission)` */
  allowed: (permission: Permission) => boolean
}

/**
 * Shared loader for the monitor pages: the signed-in user, the organization behind the URL slug
 * (404 when it does not exist or the user is not a member) and a permission helper.
 */
export async function getOrgPageContext(orgSlug: string, next: string): Promise<OrgPageContext> {
  const user = await requireUser(next)
  const payload = await getPayload({ config })
  const org = await findOrganizationBySlug(payload, user, orgSlug)
  if (!org) notFound()
  const requestUser: RequestUser = { ...user, collection: 'users' }
  return {
    payload,
    user,
    requestUser,
    org,
    allowed: (permission) => canWithOverrides(user, org, permission),
  }
}

/** Loads a monitor of the organization as the user (404 otherwise). `depth` 1 populates `parent`. */
export async function getOrgMonitor(
  ctx: OrgPageContext,
  rawId: string,
  depth: 0 | 1 = 1,
): Promise<Monitor> {
  const id = parseId(ctx.payload, rawId)
  let monitor: Monitor
  try {
    monitor = await ctx.payload.findByID({
      collection: 'monitors',
      id,
      depth,
      user: ctx.requestUser,
      overrideAccess: false,
    })
  } catch {
    notFound()
  }
  if (String(relationId(monitor.organization)) !== String(ctx.org.id)) notFound()
  return monitor
}

/** Group monitors of the organization, for the parent select. */
export async function getOrgGroups(
  ctx: OrgPageContext,
): Promise<{ id: string | number; name: string }[]> {
  const { docs } = await ctx.payload.find({
    collection: 'monitors',
    where: {
      and: [{ organization: { equals: ctx.org.id } }, { type: { equals: 'group' } }],
    },
    sort: 'name',
    limit: 200,
    depth: 0,
    user: ctx.requestUser,
    overrideAccess: false,
    disableErrors: true,
  })
  return docs.map((doc) => ({ id: doc.id, name: doc.name }))
}

export interface MonitorFormResources {
  tags: { id: string | number; name: string; color: string }[]
  proxies: { id: string | number; label: string; active: boolean; isDefault: boolean }[]
  dockerHosts: { id: string | number; name: string }[]
}

/**
 * Tags, proxies and Docker hosts of the organization for the monitor form selectors, read as the
 * user (members see all three; proxies come without passwords).
 */
export async function getMonitorFormResources(ctx: OrgPageContext): Promise<MonitorFormResources> {
  const common = {
    where: { organization: { equals: ctx.org.id } },
    depth: 0,
    limit: 500,
    user: ctx.requestUser,
    overrideAccess: false,
    disableErrors: true,
  } as const
  const [tags, proxies, dockerHosts] = await Promise.all([
    ctx.payload.find({ collection: 'tags', sort: 'name', ...common }),
    ctx.payload.find({ collection: 'proxies', ...common }),
    ctx.payload.find({ collection: 'docker-hosts', sort: 'name', ...common }),
  ])
  return {
    tags: tags.docs.map((doc) => ({ id: doc.id, name: doc.name, color: doc.color })),
    proxies: proxies.docs.map((doc) => ({
      id: doc.id,
      label: `${doc.protocol}://${doc.host}:${doc.port}`,
      active: doc.active !== false,
      isDefault: Boolean(doc.default),
    })),
    dockerHosts: dockerHosts.docs.map((doc) => ({ id: doc.id, name: doc.name })),
  }
}
