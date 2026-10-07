/**
 * Public ids of incidents and maintenance occurrences (#107, see `src/lib/status-page-events.ts`).
 *
 * New documents get a random id when they are created (the `publicId` field hook below). Documents
 * stored before the field existed have none until their next write; until then (and on that
 * write) they use an id derived from their database id with an HMAC keyed by `PAYLOAD_SECRET`, so
 * their permalinks are stable without a data migration and do not reveal the database id.
 */
import { createHmac } from 'node:crypto'

import type { FieldHook } from 'payload'

import { env } from '@/env'
import { PUBLIC_ID_LENGTH, isPublicId, randomPublicId } from '@/lib/status-page-events'

export type PublicIdCollection = 'incidents' | 'maintenance-occurrences'

/** Deterministic public id of a document that has none stored. */
export function derivePublicId(collection: PublicIdCollection, id: string | number): string {
  const digest = createHmac('sha256', env.PAYLOAD_SECRET)
    .update(`marmot:public-id:${collection}:${String(id)}`)
    .digest('hex')
  return BigInt(`0x${digest.slice(0, 16)}`)
    .toString(36)
    .padStart(PUBLIC_ID_LENGTH, '0')
    .slice(-PUBLIC_ID_LENGTH)
}

/** The stored public id, or the derived one for documents written before #107. */
export const publicIdOf = (
  collection: PublicIdCollection,
  doc: { id: string | number; publicId?: string | null },
): string => (isPublicId(doc.publicId) ? doc.publicId : derivePublicId(collection, doc.id))

/**
 * `publicId` field hook: never taken from the client. Kept once set; new documents get a random
 * id and existing documents without one get their derived id (so the permalink does not change).
 */
export const assignPublicId =
  (collection: PublicIdCollection): FieldHook =>
  ({ operation, originalDoc }) => {
    const stored = (originalDoc as { publicId?: unknown } | undefined)?.publicId
    if (isPublicId(stored)) return stored
    const id = (originalDoc as { id?: string | number } | undefined)?.id
    if (operation === 'update' && id !== undefined) return derivePublicId(collection, id)
    return randomPublicId()
  }
