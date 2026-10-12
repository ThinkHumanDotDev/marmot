import { describe, expect, it } from 'vitest'

import { migrateDown, migrateUp } from '../../migrations/mongodb/20261011_141735_ct_alerts'

import { dropUniqueIndexOn, listIndexes, type MongoIndexInfo } from './mongo-indexes'

const mongoError = (code: number, codeName: string) =>
  Object.assign(new Error(codeName), { code, codeName })

/** An in-memory stand-in for the native driver collection the migrations use. */
function fakeCollection(initial: MongoIndexInfo[] | 'missing') {
  let indexes = initial === 'missing' ? undefined : [...initial]
  const calls: { op: string; args: unknown[] }[] = []
  return {
    calls,
    get indexNames() {
      return (indexes ?? []).map((index) => index.name)
    },
    async indexes() {
      if (!indexes) throw mongoError(26, 'NamespaceNotFound')
      return indexes
    },
    async dropIndex(name: string) {
      calls.push({ op: 'dropIndex', args: [name] })
      if (!indexes?.some((index) => index.name === name)) throw mongoError(27, 'IndexNotFound')
      indexes = indexes.filter((index) => index.name !== name)
    },
    async createIndex(key: Record<string, 1>, options: { unique: boolean }) {
      calls.push({ op: 'createIndex', args: [key, options] })
      indexes = [...(indexes ?? []), { name: Object.keys(key).join('_'), key, ...options }]
    },
    async updateMany(...args: unknown[]) {
      calls.push({ op: 'updateMany', args })
    },
    async deleteMany(...args: unknown[]) {
      calls.push({ op: 'deleteMany', args })
    },
  }
}

const ID = { name: '_id_', key: { _id: 1 } }
const LEGACY = {
  name: 'type_1_monitor_1_days_1',
  key: { type: 1, monitor: 1, days: 1 },
  unique: true,
}
const CURRENT = {
  name: 'type_1_monitor_1_days_1_fingerprint_1',
  key: { type: 1, monitor: 1, days: 1, fingerprint: 1 },
  unique: true,
}

describe('mongo index helpers', () => {
  it('lists no indexes for a collection that does not exist', async () => {
    expect(await listIndexes(fakeCollection('missing'))).toEqual([])
  })

  it('rethrows other errors', async () => {
    const collection = {
      indexes: async () => {
        throw mongoError(13, 'Unauthorized')
      },
      dropIndex: async () => undefined,
    }
    await expect(listIndexes(collection)).rejects.toThrow('Unauthorized')
  })

  it('drops only a unique index on exactly the given fields', async () => {
    const nonUnique = { name: 'legacy_plain', key: { type: 1, monitor: 1, days: 1 } }
    const reordered = { name: 'reordered', key: { monitor: 1, type: 1, days: 1 }, unique: true }
    const collection = fakeCollection([ID, LEGACY, CURRENT, nonUnique, reordered])
    expect(await dropUniqueIndexOn(collection, ['type', 'monitor', 'days'])).toEqual([LEGACY.name])
    expect(collection.indexNames).toEqual([ID.name, CURRENT.name, nonUnique.name, reordered.name])
  })

  it('tolerates an index another process dropped first', async () => {
    const collection = fakeCollection([ID, LEGACY])
    const stale = {
      ...collection,
      indexes: async () => [ID, LEGACY],
      dropIndex: async () => {
        throw mongoError(27, 'IndexNotFound')
      },
    }
    expect(await dropUniqueIndexOn(stale, ['type', 'monitor', 'days'])).toEqual([LEGACY.name])
  })
})

describe('ct_alerts mongodb migration', () => {
  it('is a no-op on a fresh database without the collection', async () => {
    const collection = fakeCollection('missing')
    await migrateUp(collection)
    expect(collection.calls.filter((call) => call.op === 'dropIndex')).toEqual([])
  })

  it('is a no-op for indexes on a database created with the new schema', async () => {
    const collection = fakeCollection([ID, CURRENT])
    await migrateUp(collection)
    expect(collection.indexNames).toEqual([ID.name, CURRENT.name])
    expect(collection.calls.map((call) => call.op)).toEqual(['updateMany'])
  })

  it('drops the legacy unique index and backfills the fingerprint on an upgraded database', async () => {
    const collection = fakeCollection([ID, LEGACY, CURRENT])
    await migrateUp(collection, 'session')
    expect(collection.indexNames).toEqual([ID.name, CURRENT.name])
    expect(collection.calls).toEqual([
      { op: 'dropIndex', args: [LEGACY.name] },
      {
        op: 'updateMany',
        args: [
          { fingerprint: { $exists: false } },
          { $set: { fingerprint: '' } },
          { session: 'session' },
        ],
      },
    ])
  })

  it('is idempotent', async () => {
    const collection = fakeCollection([ID, LEGACY, CURRENT])
    await migrateUp(collection)
    await migrateUp(collection)
    expect(collection.calls.filter((call) => call.op === 'dropIndex')).toHaveLength(1)
  })

  it('restores the legacy index on down, after removing ct rows', async () => {
    const collection = fakeCollection([ID, CURRENT])
    await migrateDown(collection)
    expect(collection.calls.map((call) => call.op)).toEqual(['deleteMany', 'createIndex'])
    expect(collection.calls[0]?.args[0]).toEqual({ type: 'ct' })
    expect(collection.indexNames).toContain('type_monitor_days')
  })

  it('does nothing on down when the collection does not exist', async () => {
    const collection = fakeCollection('missing')
    await migrateDown(collection)
    expect(collection.calls).toEqual([])
  })
})
