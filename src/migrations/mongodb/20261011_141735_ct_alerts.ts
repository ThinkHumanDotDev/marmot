import type { MigrateDownArgs, MigrateUpArgs } from '@payloadcms/db-mongodb'

/**
 * Certificate transparency alerts (#143): `notification-sent-history` is unique on
 * `(type, monitor, days, fingerprint)` instead of `(type, monitor, days)`. Mongoose creates the new
 * index but never drops the old one, which would allow a single `ct` row per monitor. Rows written
 * before the field existed get the empty fingerprint the expiry warnings now store.
 */
const COLLECTION = 'notification-sent-history'
const OLD_KEY = ['type', 'monitor', 'days']

type IndexInfo = { name?: string; key: Record<string, unknown>; unique?: boolean }

type NativeCollection = {
  indexes: () => Promise<IndexInfo[]>
  dropIndex: (name: string) => Promise<unknown>
  createIndex: (key: Record<string, 1>, options: { unique: boolean }) => Promise<unknown>
  updateMany: (filter: object, update: object, options?: object) => Promise<unknown>
  deleteMany: (filter: object) => Promise<unknown>
}

const collectionOf = (payload: MigrateUpArgs['payload']): NativeCollection | undefined =>
  (payload.db as unknown as { collections: Record<string, { collection: NativeCollection }> })
    .collections[COLLECTION]?.collection

export async function up({ payload, session }: MigrateUpArgs): Promise<void> {
  const collection = collectionOf(payload)
  if (!collection) return
  let indexes: IndexInfo[] = []
  try {
    indexes = await collection.indexes()
  } catch {
    return // the collection does not exist yet: nothing to fix
  }
  for (const index of indexes) {
    if (index.name && index.unique && Object.keys(index.key).join(',') === OLD_KEY.join(',')) {
      await collection.dropIndex(index.name)
    }
  }
  await collection.updateMany(
    { fingerprint: { $exists: false } },
    { $set: { fingerprint: '' } },
    { session },
  )
}

export async function down({ payload }: MigrateDownArgs): Promise<void> {
  const collection = collectionOf(payload)
  if (!collection) return
  await collection.deleteMany({ type: 'ct' })
  await collection.createIndex(Object.fromEntries(OLD_KEY.map((k) => [k, 1])), { unique: true })
}
