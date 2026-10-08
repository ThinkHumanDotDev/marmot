import 'server-only'

import { notFound } from 'next/navigation'
import { getPayload, type Payload } from 'payload'

import config from '@payload-config'
import { canWithOverrides, type Permission } from '@/access/permissions'
import { requireUser, type CurrentUser } from '@/lib/auth'
import type { Monitor, Organization } from '@/payload-types'
import { parseId, relationId, type RequestUser } from '@/server/monitors/http'
import {
  getNotificationProvider,
  type NotificationProviderGroup,
} from '@/server/notification-providers'
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

/** Notification channel as the monitor pages show it: no config, so no secrets. */
export interface MonitorChannelOption {
  id: string | number
  name: string
  type: string
  /** Provider label (`Slack`), or the raw type when the provider is not registered. */
  typeLabel: string
  group: NotificationProviderGroup | null
  active: boolean
  isDefault: boolean
}

export interface MonitorFormResources {
  tags: { id: string | number; name: string; color: string }[]
  proxies: { id: string | number; label: string; active: boolean; isDefault: boolean }[]
  dockerHosts: { id: string | number; name: string }[]
  /** Probe locations (#91) a monitor can be checked from besides the local workers. */
  locations: { id: string | number; name: string; status: string }[]
  /** Channels of the organization (empty when the user may not read them). */
  notifications: MonitorChannelOption[]
}

const toChannelOption = (doc: {
  id: string | number
  name: string
  type: string
  active?: boolean | null
  isDefault?: boolean | null
}): MonitorChannelOption => {
  const provider = getNotificationProvider(doc.type)
  return {
    id: doc.id,
    name: doc.name,
    type: doc.type,
    typeLabel: provider?.label ?? doc.type,
    group: provider?.group ?? null,
    active: doc.active !== false,
    isDefault: Boolean(doc.isDefault),
  }
}

/**
 * Channels attached to a monitor, for its detail page. Viewers may not read channels (their
 * configs hold secrets), so the names and types are read with access overridden and nothing else
 * leaves the server. Channels of another organization are never returned.
 */
export async function getMonitorChannels(
  ctx: OrgPageContext,
  monitor: Pick<Monitor, 'id'>,
): Promise<MonitorChannelOption[]> {
  // Ids at depth 0: a populated relationship the user may not read would not carry them reliably.
  const { notifications } = await ctx.payload.findByID({
    collection: 'monitors',
    id: monitor.id,
    select: { notifications: true },
    depth: 0,
    overrideAccess: true,
  })
  const ids = (notifications ?? [])
    .map((item) => relationId(item))
    .filter((id): id is string | number => id !== null)
  if (ids.length === 0) return []
  const { docs } = await ctx.payload.find({
    collection: 'notifications',
    where: { and: [{ id: { in: ids } }, { organization: { equals: ctx.org.id } }] },
    select: { name: true, type: true, active: true, isDefault: true },
    sort: 'name',
    depth: 0,
    limit: ids.length,
    pagination: false,
    overrideAccess: true,
  })
  return docs.map(toChannelOption)
}

/**
 * Tags, proxies, Docker hosts and notification channels of the organization for the monitor form
 * selectors, read as the user (members see all four; proxies come without passwords, channels
 * without their config).
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
  const [tags, proxies, dockerHosts, locations, notifications] = await Promise.all([
    ctx.payload.find({ collection: 'tags', sort: 'name', ...common }),
    ctx.payload.find({ collection: 'proxies', ...common }),
    ctx.payload.find({ collection: 'docker-hosts', sort: 'name', ...common }),
    ctx.payload.find({
      collection: 'locations',
      sort: 'name',
      select: { name: true, status: true },
      ...common,
    }),
    ctx.allowed('notification:read')
      ? ctx.payload.find({
          collection: 'notifications',
          sort: 'name',
          select: { name: true, type: true, active: true, isDefault: true },
          ...common,
        })
      : Promise.resolve({ docs: [] }),
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
    locations: locations.docs.map((doc) => ({
      id: doc.id,
      name: doc.name,
      status: doc.status ?? 'unknown',
    })),
    notifications: notifications.docs.map(toChannelOption),
  }
}

/**
 * Tags, notification channels and probe locations for the monitor list's filters and bulk actions
 * (#124), read as the user. `notifications` is `null` when the user may not read channels (viewers),
 * so the list hides that filter instead of offering an empty one.
 */
export async function getMonitorListResources(ctx: OrgPageContext): Promise<{
  tags: { id: string; name: string; color: string | null }[]
  notifications: { id: string; name: string }[] | null
  locations: { id: string; name: string }[]
}> {
  const common = {
    where: { organization: { equals: ctx.org.id } },
    sort: 'name',
    depth: 0,
    limit: 500,
    user: ctx.requestUser,
    overrideAccess: false,
    disableErrors: true,
  } as const
  const canReadChannels = ctx.allowed('notification:read')
  const [tags, locations, notifications] = await Promise.all([
    ctx.payload.find({ collection: 'tags', select: { name: true, color: true }, ...common }),
    ctx.payload.find({ collection: 'locations', select: { name: true }, ...common }),
    canReadChannels
      ? ctx.payload.find({ collection: 'notifications', select: { name: true }, ...common })
      : Promise.resolve(null),
  ])
  return {
    tags: tags.docs.map((doc) => ({
      id: String(doc.id),
      name: doc.name,
      color: doc.color ?? null,
    })),
    locations: locations.docs.map((doc) => ({ id: String(doc.id), name: doc.name })),
    notifications: notifications
      ? notifications.docs.map((doc) => ({ id: String(doc.id), name: doc.name }))
      : null,
  }
}
