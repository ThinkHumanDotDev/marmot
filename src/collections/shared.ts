import type { CollectionBeforeDeleteHook, CollectionSlug, FieldAccess } from 'payload'

import { can, isSuperadmin, type Permission, type UserLike } from '@/access/permissions'

/** Id of a relationship value whether or not it was populated. */
export const relId = (value: unknown): string | number | null => {
  if (typeof value === 'string' || typeof value === 'number') return value
  if (value && typeof value === 'object' && 'id' in value) {
    const id = (value as { id: unknown }).id
    if (typeof id === 'string' || typeof id === 'number') return id
  }
  return null
}

/**
 * Field-level read access for secrets of org-scoped documents: only users holding `permission` in
 * the document's organization (and superadmins) receive the value; everyone else gets the field
 * stripped. Background code reads with `overrideAccess: true` and is unaffected.
 */
export const secretReadAccess =
  (permission: Permission): FieldAccess =>
  ({ req, doc }) => {
    const user = req.user as UserLike | null | undefined
    if (!user) return false
    if (isSuperadmin(user)) return true
    const org = relId((doc as { organization?: unknown } | undefined)?.organization)
    return org !== null && can(user, org, permission)
  }

/**
 * `beforeDelete` hook for collections monitors point at with a single relationship (`proxy`,
 * `dockerHost`): clear the reference on every monitor first, so no dangling id is left behind on
 * either database.
 */
export const detachMonitorRelation =
  (field: 'proxy' | 'dockerHost'): CollectionBeforeDeleteHook =>
  async ({ id, req }) => {
    await req.payload.update({
      collection: 'monitors' as CollectionSlug,
      where: { [field]: { equals: id } },
      data: { [field]: null },
      depth: 0,
      req,
      overrideAccess: true,
      context: { skipEngineSync: true },
    })
  }
