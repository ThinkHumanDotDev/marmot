import type { MigrateDownArgs, MigrateUpArgs } from '@payloadcms/db-mongodb'

import {
  dropUniqueIndexOn,
  listIndexes,
  type MongoMigrationCollection,
} from '../../server/db/mongo-indexes'

/**
 * Certificate transparency alerts (#143): `notification-sent-history` is unique on
 * `(type, monitor, days, fingerprint)` instead of `(type, monitor, days)`. Mongoose creates the new
 * index but never drops the old one, which would allow a single `ct` row per monitor. Rows written
 * before the field existed get the empty fingerprint the expiry warnings now store.
 *
 * On a fresh database the collection and the old index do not exist, and `up` does nothing.
 */
const COLLECTION = 'notification-sent-history'
export const LEGACY_UNIQUE_KEY = ['type', 'monitor', 'days'] as const

type NativeCollection = MongoMigrationCollection & {
  createIndex: (key: Record<string, 1>, options: { unique: boolean }) => Promise<unknown>
  updateMany: (filter: object, update: object, options?: object) => Promise<unknown>
  deleteMany: (filter: object, options?: object) => Promise<unknown>
}

const collectionOf = (payload: MigrateUpArgs['payload']): NativeCollection | undefined =>
  (payload.db as unknown as { collections: Record<string, { collection: NativeCollection }> })
    .collections[COLLECTION]?.collection

/** The migration body, separate from Payload's arguments so it can be tested against a fake. */
export async function migrateUp(collection: NativeCollection, session?: unknown): Promise<void> {
  // Index changes cannot run inside a transaction, so they do not take the session.
  await dropUniqueIndexOn(collection, LEGACY_UNIQUE_KEY)
  await collection.updateMany(
    { fingerprint: { $exists: false } },
    { $set: { fingerprint: '' } },
    session ? { session } : undefined,
  )
}

export async function migrateDown(collection: NativeCollection, session?: unknown): Promise<void> {
  if ((await listIndexes(collection)).length === 0) return
  await collection.deleteMany({ type: 'ct' }, session ? { session } : undefined)
  await collection.createIndex(Object.fromEntries(LEGACY_UNIQUE_KEY.map((k) => [k, 1])), {
    unique: true,
  })
}

export async function up({ payload, session }: MigrateUpArgs): Promise<void> {
  const collection = collectionOf(payload)
  if (collection) await migrateUp(collection, session)
}

export async function down({ payload, session }: MigrateDownArgs): Promise<void> {
  const collection = collectionOf(payload)
  if (collection) await migrateDown(collection, session)
}
