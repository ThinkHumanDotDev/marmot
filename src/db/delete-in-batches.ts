import type { CollectionSlug, Payload, Where } from 'payload'

import { childLogger } from '@/lib/logger'

const log = childLogger('db:delete-in-batches')

/** Rows deleted per round trip by `deleteInBatches` unless the caller passes `batchSize`. */
export const DELETE_BATCH_SIZE = 1000

export type DeleteInBatchesOptions = {
  /** Rows per batch (default `DELETE_BATCH_SIZE`). */
  batchSize?: number
  /**
   * Run collection hooks (`payload.delete` per batch) instead of deleting straight through the
   * database adapter (`payload.db.deleteMany`). Use it for collections whose `beforeDelete` /
   * `afterDelete` hooks must run (cascades, audit rows, schedulers).
   */
  hooks?: boolean
}

/**
 * Delete every document of `collection` that matches `where`, at most `batchSize` at a time, and
 * return how many were deleted. `payload.delete({ where })` loads every matching document into
 * memory before deleting it, which runs a large backlog out of heap (#237); this only ever holds the
 * ids of one batch. Works on every adapter: ids come from `payload.find` (`limit`, `depth: 0`, id
 * only) and each batch is deleted with `id in [...]`. No transaction spans the loop, so every batch
 * is committed on its own and an interrupted run keeps its progress.
 *
 * Without `hooks`, rows are removed with `payload.db.deleteMany`: no access checks, no collection
 * hooks, no versions or document locks to clean up. Only use that for collections without delete
 * hooks (telemetry and logs).
 */
export async function deleteInBatches(
  payload: Payload,
  collection: CollectionSlug,
  where: Where,
  { batchSize = DELETE_BATCH_SIZE, hooks = false }: DeleteInBatchesOptions = {},
): Promise<number> {
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new Error(`deleteInBatches: batchSize must be a positive integer (got ${batchSize})`)
  }
  // Ids a hook refused to delete; excluded from later batches so the loop always makes progress.
  const failed: (string | number)[] = []
  let deleted = 0

  for (;;) {
    const scope: Where = failed.length > 0 ? { and: [where, { id: { not_in: failed } }] } : where
    const { docs } = (await payload.find({
      collection,
      where: scope,
      limit: batchSize,
      pagination: false,
      depth: 0,
      sort: 'id',
      // Only the id; the generated select types of a generic slug do not list `id` itself.
      select: { id: true } as never,
      overrideAccess: true,
    })) as unknown as { docs: { id: string | number }[] }
    if (docs.length === 0) break
    const ids = docs.map((doc) => doc.id)

    if (hooks) {
      const result = await payload.delete({
        collection,
        where: { id: { in: ids } },
        depth: 0,
        overrideAccess: true,
      })
      deleted += result.docs.length
      if (result.errors.length > 0) {
        log.warn({ collection, errors: result.errors.length }, 'some rows could not be deleted')
        failed.push(...result.errors.map((error) => error.id))
        if (failed.length >= batchSize) {
          log.warn({ collection, failed: failed.length }, 'too many rows failed, stopping')
          break
        }
      }
    } else {
      await payload.db.deleteMany({ collection, where: { id: { in: ids } } })
      deleted += ids.length
    }

    if (docs.length < batchSize) break
  }
  return deleted
}
