import { z } from 'zod'

import { canInOrg } from '@/access/overrides'
import type { OrgId } from '@/access/permissions'
import type { ChannelMonitorRow } from '@/components/notifications/types'
import type { Monitor, Notification } from '@/payload-types'
import {
  errorMessage,
  errorStatus,
  jsonError,
  parseDocId,
  readJson,
  resolveOrgRequest,
  type OrgRequestContext,
} from '@/server/notifications/api'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ orgId: string; id: string }> }

const relId = (value: unknown): OrgId | null =>
  value && typeof value === 'object' && 'id' in value
    ? (value as { id: OrgId }).id
    : ((value as OrgId | null | undefined) ?? null)

async function loadChannel(ctx: OrgRequestContext, rawId: string): Promise<Notification | null> {
  try {
    const doc = (await ctx.payload.findByID({
      collection: 'notifications',
      id: parseDocId(ctx.payload, rawId),
      depth: 0,
      user: ctx.user,
      overrideAccess: false,
    })) as Notification
    return String(relId(doc.organization)) === String(ctx.orgId) ? doc : null
  } catch {
    return null
  }
}

/** Every monitor of the organization the caller may read, with its channel ids. */
async function loadOrgMonitors(ctx: OrgRequestContext): Promise<Monitor[]> {
  const { docs } = await ctx.payload.find({
    collection: 'monitors',
    where: { organization: { equals: ctx.orgId } },
    sort: 'name',
    depth: 0,
    limit: 0,
    pagination: false,
    user: ctx.user,
    overrideAccess: false,
  })
  return docs as Monitor[]
}

const channelIds = (monitor: Monitor): OrgId[] =>
  (monitor.notifications ?? []).map(relId).filter((id): id is OrgId => id !== null)

const isAttached = (monitor: Monitor, channelId: OrgId) =>
  channelIds(monitor).some((id) => String(id) === String(channelId))

const toRows = (monitors: Monitor[], channelId: OrgId): ChannelMonitorRow[] =>
  monitors.map((monitor) => ({
    id: String(monitor.id),
    name: monitor.name,
    type: monitor.type,
    active: monitor.active !== false,
    attached: isAttached(monitor, channelId),
  }))

/**
 * GET /api/orgs/:orgId/notifications/:id/monitors — the organization's monitors and whether each
 * one alerts through this channel (`notification:read`).
 */
export async function GET(request: Request, { params }: RouteContext) {
  const { orgId, id } = await params
  const ctx = await resolveOrgRequest(request, orgId, 'notification:read')
  if (ctx instanceof Response) return ctx

  const channel = await loadChannel(ctx, id)
  if (!channel) return jsonError(404, 'Notification channel not found')

  return Response.json({ monitors: toRows(await loadOrgMonitors(ctx), channel.id) })
}

const putSchema = z.object({
  monitors: z.array(z.union([z.string().min(1), z.number().int().positive()])).max(10_000),
})

/**
 * PUT /api/orgs/:orgId/notifications/:id/monitors — set which monitors alert through this channel.
 * Body: `{ monitors: [id, …] }`, the complete list; monitors missing from it are detached. Needs
 * `notification:update` and `monitor:update`. Responds with the updated list.
 */
export async function PUT(request: Request, { params }: RouteContext) {
  const { orgId, id } = await params
  const ctx = await resolveOrgRequest(request, orgId, 'notification:update')
  if (ctx instanceof Response) return ctx
  if (!(await canInOrg(ctx.payload, ctx.user, ctx.orgId, 'monitor:update'))) {
    return jsonError(403, 'Forbidden')
  }

  const channel = await loadChannel(ctx, id)
  if (!channel) return jsonError(404, 'Notification channel not found')

  const parsed = putSchema.safeParse(await readJson(request))
  if (!parsed.success) return jsonError(400, 'Expected { monitors: [id, …] }')

  const monitors = await loadOrgMonitors(ctx)
  const wanted = new Set(parsed.data.monitors.map(String))
  const known = new Set(monitors.map((monitor) => String(monitor.id)))
  const unknown = [...wanted].filter((monitorId) => !known.has(monitorId))
  if (unknown.length > 0) {
    return jsonError(
      400,
      `Unknown monitor${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}`,
    )
  }

  try {
    for (const monitor of monitors) {
      const attached = isAttached(monitor, channel.id)
      const attach = wanted.has(String(monitor.id))
      if (attached === attach) continue
      const current = channelIds(monitor)
      const next = attach
        ? [...current, channel.id]
        : current.filter((channelId) => String(channelId) !== String(channel.id))
      const updated = await ctx.payload.update({
        collection: 'monitors',
        id: monitor.id,
        data: { notifications: next as Monitor['notifications'] },
        depth: 0,
        user: ctx.user,
        overrideAccess: false,
        // The schedule is unchanged; the worker reads the channels at the next transition.
        context: { skipEngineSync: true },
      })
      monitor.notifications = updated.notifications
    }
  } catch (error) {
    return jsonError(errorStatus(error), errorMessage(error))
  }

  return Response.json({ monitors: toRows(monitors, channel.id) })
}
