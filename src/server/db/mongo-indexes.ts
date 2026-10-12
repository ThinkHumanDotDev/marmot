/**
 * Helpers for MongoDB migrations (`src/migrations/mongodb`). Mongoose creates the indexes a
 * collection config declares but never drops the ones it no longer declares, so a migration that
 * changes a unique index has to drop the old one itself. These helpers work on the native driver
 * collection and are safe to run on a fresh database (no collection, no old index).
 *
 * They live outside the migrations directory because Payload treats every file in it as a migration.
 */

export type MongoIndexInfo = { name?: string; key: Record<string, unknown>; unique?: boolean }

/** The subset of the native MongoDB collection API the migrations use. */
export type MongoMigrationCollection = {
  indexes: () => Promise<MongoIndexInfo[]>
  dropIndex: (name: string) => Promise<unknown>
}

/** MongoDB's error code for an operation on a collection that does not exist. */
const NAMESPACE_NOT_FOUND = 26

const isNamespaceNotFound = (err: unknown): boolean => {
  const { code, codeName } = (err ?? {}) as { code?: unknown; codeName?: unknown }
  return code === NAMESPACE_NOT_FOUND || codeName === 'NamespaceNotFound'
}

/** Reads a collection's indexes; a collection that does not exist yet has none. */
export async function listIndexes(collection: MongoMigrationCollection): Promise<MongoIndexInfo[]> {
  try {
    return await collection.indexes()
  } catch (err) {
    if (isNamespaceNotFound(err)) return []
    throw err
  }
}

/** Whether an index is unique on exactly these fields, in this order. */
export const isUniqueIndexOn = (index: MongoIndexInfo, fields: readonly string[]): boolean =>
  index.unique === true && Object.keys(index.key).join('\u0000') === fields.join('\u0000')

/**
 * Drops every unique index on exactly `fields` (in that order) and returns the names it dropped. A
 * missing collection or index is a no-op, so the migration can run on new and upgraded databases.
 */
export async function dropUniqueIndexOn(
  collection: MongoMigrationCollection,
  fields: readonly string[],
): Promise<string[]> {
  const dropped: string[] = []
  for (const index of await listIndexes(collection)) {
    if (!index.name || !isUniqueIndexOn(index, fields)) continue
    try {
      await collection.dropIndex(index.name)
    } catch (err) {
      // Another process (a second replica starting up) dropped it first.
      if (!isIndexNotFound(err)) throw err
    }
    dropped.push(index.name)
  }
  return dropped
}

/** MongoDB's error code for dropping an index that does not exist. */
const INDEX_NOT_FOUND = 27

const isIndexNotFound = (err: unknown): boolean => {
  const { code, codeName } = (err ?? {}) as { code?: unknown; codeName?: unknown }
  return code === INDEX_NOT_FOUND || codeName === 'IndexNotFound' || isNamespaceNotFound(err)
}
