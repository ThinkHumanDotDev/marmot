import 'server-only'

import { notFound } from 'next/navigation'
import { getPayload, type Payload } from 'payload'

import config from '@payload-config'
import { can, type Permission } from '@/access/permissions'
import { requireUser, type CurrentUser } from '@/lib/auth'
import type { Monitor, Organization } from '@/payload-types'
import { parseId, relationId, type RequestUser } from '@/server/monitors/http'
import { findOrganizationBySlug } from '@/server/organizations/resolve'

export interface OrgPageContext {
  payload: Payload
  user: CurrentUser
  requestUser: RequestUser
  org: Organization
  /** `can(user, org.id, permission)` */
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
    allowed: (permission) => can(user, org.id, permission),
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
