/**
 * Audience membership of self sign-ups (#278). A visitor who subscribes on an `audience` page is
 * signed in; the subscription records their `status-page-viewers` row (`viewer`) next to the
 * audiences the session granted. Whenever membership can shrink, the subscriptions of the page's
 * viewers are checked again:
 *
 * - an audience's addresses or domains change, or the audience is deleted;
 * - a viewer is revoked.
 *
 * A subscription keeps only the audiences that still list its viewer; one left without any (or whose
 * viewer was revoked) ends: the row and its delivery log are deleted, so nothing more is sent.
 * Subscriptions an owner added or imported have no viewer and are left alone; a viewer row that was
 * deleted (the visitor was only forgotten) unties the subscription the same way.
 */
import type { Payload, PayloadRequest } from 'payload'

import { isAudienceMember } from '@/lib/status-page-audiences'
import { childLogger } from '@/lib/logger'
import type { StatusPageAudience, StatusPageSubscriber, StatusPageViewer } from '@/payload-types'
import { findPageAudiences } from '@/server/status-pages/audiences'

const log = childLogger('status-pages:subscribers:audiences')

type Id = string | number

const idOf = (value: unknown): Id | null => {
  if (typeof value === 'string' || typeof value === 'number') return value
  if (value && typeof value === 'object' && 'id' in value) {
    const id = (value as { id: unknown }).id
    if (typeof id === 'string' || typeof id === 'number') return id
  }
  return null
}

/** Ids of the audiences among `audiences` that list `email`. */
export const memberAudienceIds = (
  audiences: readonly StatusPageAudience[],
  email: string,
): Set<string> =>
  new Set(audiences.filter((a) => isAudienceMember(a, email)).map((a) => String(a.id)))

export interface ReconcileResult {
  /** Subscriptions that lost some (not all) of their audiences. */
  narrowed: number
  /** Subscriptions that ended. */
  ended: number
}

/**
 * Re-checks the viewer-bound subscriptions of `pageId` (only those of `viewerIds` when given)
 * against the page's current audiences. Pass `req` from a hook so the work joins its transaction.
 */
export async function reconcileViewerSubscriptions(
  payload: Payload,
  pageId: Id,
  { req, viewerIds }: { req?: PayloadRequest; viewerIds?: readonly Id[] } = {},
): Promise<ReconcileResult> {
  const result: ReconcileResult = { narrowed: 0, ended: 0 }
  const { docs: subscribers } = await payload.find({
    collection: 'status-page-subscribers',
    where: {
      and: [
        { statusPage: { equals: pageId } },
        viewerIds ? { viewer: { in: [...viewerIds] } } : { viewer: { exists: true } },
      ],
    },
    depth: 0,
    limit: 0,
    pagination: false,
    overrideAccess: true,
    req,
    select: { viewer: true, audiences: true },
  })
  const bound = (subscribers as Pick<StatusPageSubscriber, 'id' | 'viewer' | 'audiences'>[])
    .map((s) => ({ ...s, viewerId: idOf(s.viewer) }))
    .filter((s): s is typeof s & { viewerId: Id } => s.viewerId !== null)
  if (bound.length === 0) return result

  const [audiences, { docs: viewers }] = await Promise.all([
    findPageAudiences(payload, pageId, req),
    payload.find({
      collection: 'status-page-viewers',
      where: { id: { in: [...new Set(bound.map((s) => s.viewerId))] } },
      depth: 0,
      limit: 0,
      pagination: false,
      overrideAccess: true,
      req,
      select: { email: true, status: true },
    }),
  ])
  const byId = new Map(
    (viewers as Pick<StatusPageViewer, 'id' | 'email' | 'status'>[]).map((v) => [String(v.id), v]),
  )

  for (const subscriber of bound) {
    const viewer = byId.get(String(subscriber.viewerId))
    // Deleted viewer: the visitor was forgotten, not revoked; the subscription is untied.
    if (!viewer) continue
    const member =
      viewer.status === 'active' ? memberAudienceIds(audiences, viewer.email) : new Set<string>()
    const stored = (subscriber.audiences ?? []).map((a) => String(idOf(a)))
    const kept = stored.filter((id) => member.has(id))
    if (kept.length === 0) {
      await payload.delete({
        collection: 'status-page-subscribers',
        id: subscriber.id,
        overrideAccess: true,
        req,
      })
      result.ended += 1
    } else if (kept.length !== stored.length) {
      await payload.update({
        collection: 'status-page-subscribers',
        id: subscriber.id,
        data: { audiences: kept as unknown as StatusPageSubscriber['audiences'] },
        depth: 0,
        overrideAccess: true,
        req,
      })
      result.narrowed += 1
    }
  }
  if (result.ended + result.narrowed > 0) {
    log.info({ pageId, ...result }, 'audience membership changed: subscriptions updated')
  }
  return result
}
