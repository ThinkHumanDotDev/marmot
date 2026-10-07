import type { BaseDatabaseAdapter, PayloadRequest } from 'payload'

import { childLogger } from '@/lib/logger'

const log = childLogger('db:after-commit')

type Callback = () => unknown
type TransactionID = Awaited<ReturnType<BaseDatabaseAdapter['beginTransaction']>>
type IncomingID = TransactionID | Promise<TransactionID>

const REGISTRY = Symbol.for('marmot.afterCommit')

type TransactionAdapter = Pick<BaseDatabaseAdapter, 'commitTransaction' | 'rollbackTransaction'>
type PatchedAdapter = TransactionAdapter & { [REGISTRY]?: Map<string, Callback[]> }

async function runAll(callbacks: Callback[] | undefined): Promise<void> {
  for (const callback of callbacks ?? []) {
    try {
      await callback()
    } catch (err) {
      log.error({ err }, 'after-commit callback failed')
    }
  }
}

/**
 * Payload 3 has no "after commit" hook: collection `afterChange`/`afterDelete` hooks run inside the
 * operation's transaction, so anything they tell another process (BullMQ, socket.io) can race the
 * commit. This wraps the adapter's own `commitTransaction`/`rollbackTransaction` (part of
 * `BaseDatabaseAdapter`, implemented by the Postgres, MongoDB and SQLite adapters alike) once, so
 * callbacks queued per transaction id run after a commit and are dropped on a rollback. Payload's
 * operations and our manual transactions (`setup.ts`, import/export) all end through these methods.
 */
function registryFor(db: TransactionAdapter): Map<string, Callback[]> {
  const adapter = db as PatchedAdapter
  const existing = adapter[REGISTRY]
  if (existing) return existing

  const pending = new Map<string, Callback[]>()
  const commit = adapter.commitTransaction.bind(adapter)
  const rollback = adapter.rollbackTransaction.bind(adapter)

  adapter.commitTransaction = async (incoming: IncomingID) => {
    const id = await incoming
    await commit(id as Parameters<BaseDatabaseAdapter['commitTransaction']>[0])
    if (id === null || id === undefined) return
    const callbacks = pending.get(String(id))
    pending.delete(String(id))
    await runAll(callbacks)
  }
  adapter.rollbackTransaction = async (incoming: IncomingID) => {
    const id = await incoming
    if (id !== null && id !== undefined) pending.delete(String(id))
    await rollback(id as Parameters<BaseDatabaseAdapter['rollbackTransaction']>[0])
  }

  adapter[REGISTRY] = pending
  return pending
}

/**
 * Run `callback` once the request's transaction has committed, or right away when the request has
 * no transaction (transactions disabled, MongoDB without a replica set, `disableTransaction`).
 * Callbacks of a rolled-back transaction never run. Errors are logged, never thrown into the commit.
 */
export async function afterCommit(
  req: Pick<PayloadRequest, 'payload' | 'transactionID'>,
  callback: Callback,
): Promise<void> {
  const id = await req.transactionID
  // Only string and number ids name a transaction. Without transactions (MongoDB without a replica
  // set) Payload's dataloader can leave a non-id behind: it round-trips the pending
  // `transactionID` promise through JSON and assigns the result, `{}`, back to the request.
  const isTransaction = typeof id === 'string' || typeof id === 'number'
  if (!isTransaction || typeof req.payload.db.commitTransaction !== 'function') {
    await runAll([callback])
    return
  }
  const pending = registryFor(req.payload.db)
  const key = String(id)
  const queued = pending.get(key)
  if (queued) queued.push(callback)
  else pending.set(key, [callback])
}
