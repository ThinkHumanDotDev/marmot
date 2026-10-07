/**
 * Who may see a monitor's badge. Badges are embedded in READMEs and dashboards without a session,
 * so the rule is: the monitor appears on a published public status page, or on a published
 * protected page the visitor has access to (its access cookie, or `?pw=`), or the request carries
 * an API key of the monitor's organization. Everything else is a 404 so that badge URLs do not
 * reveal which monitor ids exist.
 */
import type { CollectionSlug, Payload } from 'payload'

import type { Monitor, StatusPage } from '@/payload-types'
import { authenticateApiKey } from '@/server/api-keys'
import {
  accessRequestFrom,
  checkStatusPageAccess,
  isProtectedPage,
} from '@/server/status-pages/access'

/** Slug of the status pages collection (issue #11); checked at runtime so this works before it lands. */
export const STATUS_PAGES_SLUG = 'status-pages'

export const relationId = (value: unknown): string | number | null => {
  if (value === null || value === undefined) return null
  if (typeof value === 'object') return (value as { id: string | number }).id ?? null
  return value as string | number
}

export const hasStatusPages = (payload: Payload): boolean =>
  Boolean(payload.collections[STATUS_PAGES_SLUG as CollectionSlug])

/** Protected pages checked per badge request; a monitor is rarely on more than a couple. */
const MAX_PROTECTED_PAGES = 5

/** Published status pages that list the monitor in one of their groups (access fields only). */
async function publishedPagesWithMonitor(
  payload: Payload,
  monitorId: string | number,
): Promise<Pick<StatusPage, 'id' | 'access' | 'passwordHash'>[]> {
  if (!hasStatusPages(payload)) return []
  const { docs } = await payload.find({
    collection: STATUS_PAGES_SLUG as CollectionSlug,
    where: {
      and: [{ published: { equals: true } }, { 'groups.monitors.monitor': { equals: monitorId } }],
    },
    depth: 0,
    limit: 50,
    pagination: false,
    overrideAccess: true,
    select: { access: true, passwordHash: true },
  })
  return docs as unknown as Pick<StatusPage, 'id' | 'access' | 'passwordHash'>[]
}

/** `true` when a published, public (not password-protected) status page lists the monitor. */
export async function isMonitorOnPublishedStatusPage(
  payload: Payload,
  monitorId: string | number,
): Promise<boolean> {
  const pages = await publishedPagesWithMonitor(payload, monitorId)
  return pages.some((page) => !isProtectedPage(page))
}

/**
 * `public`: the monitor is on a public page. `status-page`: on a password-protected page the
 * visitor may view (the response must stay private). `api-key`: an API key of the organization.
 */
export type BadgeAccess = 'public' | 'status-page' | 'api-key' | null

/** Resolve whether `request` may see badges for `monitor`; `null` means deny. */
export async function badgeAccess(
  payload: Payload,
  monitor: Monitor,
  request: Request,
): Promise<BadgeAccess> {
  const auth = await authenticateApiKey(payload, request)
  const owner = relationId(monitor.organization)
  if (auth && owner !== null && String(auth.organizationId) === String(owner)) return 'api-key'

  const pages = await publishedPagesWithMonitor(payload, monitor.id)
  if (pages.some((page) => !isProtectedPage(page))) return 'public'

  const accessRequest = accessRequestFrom(request)
  for (const page of pages.slice(0, MAX_PROTECTED_PAGES)) {
    const decision = await checkStatusPageAccess(payload, page, accessRequest)
    if (decision.allowed) return 'status-page'
    // Once rate limited, stop: the remaining pages would only add more guesses.
    if (decision.reason === 'rate-limited') return null
  }
  return null
}
