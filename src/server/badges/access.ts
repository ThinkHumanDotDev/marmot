/**
 * Who may see a monitor's badge. Badges are embedded in READMEs and dashboards without a session,
 * so the rule is: the monitor appears on a published status page (public already), or the request
 * carries an API key of the monitor's organization. Everything else is a 404 so that badge URLs do
 * not reveal which monitor ids exist.
 */
import type { CollectionSlug, Payload } from 'payload'

import type { Monitor } from '@/payload-types'
import { authenticateApiKey } from '@/server/api-keys'

/** Slug of the status pages collection (issue #11); checked at runtime so this works before it lands. */
export const STATUS_PAGES_SLUG = 'status-pages'

export const relationId = (value: unknown): string | number | null => {
  if (value === null || value === undefined) return null
  if (typeof value === 'object') return (value as { id: string | number }).id ?? null
  return value as string | number
}

export const hasStatusPages = (payload: Payload): boolean =>
  Boolean(payload.collections[STATUS_PAGES_SLUG as CollectionSlug])

/** `true` when a published status page lists the monitor in one of its groups. */
export async function isMonitorOnPublishedStatusPage(
  payload: Payload,
  monitorId: string | number,
): Promise<boolean> {
  if (!hasStatusPages(payload)) return false
  const { totalDocs } = await payload.find({
    collection: STATUS_PAGES_SLUG as CollectionSlug,
    where: {
      and: [{ published: { equals: true } }, { 'groups.monitors.monitor': { equals: monitorId } }],
    },
    depth: 0,
    limit: 1,
    overrideAccess: true,
  })
  return totalDocs > 0
}

export type BadgeAccess = 'status-page' | 'api-key' | null

/** Resolve whether `request` may see badges for `monitor`; `null` means deny. */
export async function badgeAccess(
  payload: Payload,
  monitor: Monitor,
  request: Request,
): Promise<BadgeAccess> {
  const auth = await authenticateApiKey(payload, request)
  const owner = relationId(monitor.organization)
  if (auth && owner !== null && String(auth.organizationId) === String(owner)) return 'api-key'
  if (await isMonitorOnPublishedStatusPage(payload, monitor.id)) return 'status-page'
  return null
}
