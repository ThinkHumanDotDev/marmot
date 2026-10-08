/**
 * The demo reset (#159): wipe every collection and reseed the fixed dataset, on boot and then as the
 * `demo-reset` BullMQ job scheduler on the `marmot:maintenance` queue (every
 * `DEMO_RESET_INTERVAL_MINUTES`). The queue's single consumer per worker, a Redis lock across
 * workers and a one-minute debounce (the boot job and a freshly created scheduler's first run) keep
 * resets from overlapping.
 *
 * Idempotent: the result only depends on the dataset and the clock, and a reset interrupted half way
 * is completed by the next one. Deletes go through `deleteInBatches` (no transaction spans the loop,
 * which is also what MongoDB without a replica set needs) in an order that never leaves a required
 * reference dangling on Postgres.
 *
 * Safety: a database that holds any account besides the demo accounts is never wiped unless
 * `DEMO_MODE_FORCE` is set; the worker refuses to start against it, and every reset checks again.
 */
import type { Job, Queue } from 'bullmq'
import type { Redis } from 'ioredis'
import type { CollectionSlug, Payload } from 'payload'

import { deleteInBatches } from '@/db/delete-in-batches'
import { env } from '@/env'
import { childLogger } from '@/lib/logger'

import { DEMO_ACCOUNT, DEMO_ORGANIZATION_SLUG, demoResetIntervalMs, isDemoMode } from './config'
import { DEMO_MEMBERS } from './dataset'
import { seedDemoData, type SeedResult } from './seed'

const log = childLogger('demo:reset')

export const DEMO_RESET_JOB_NAME = 'demo-reset'
/** Job id of the reset enqueued at boot (deduplicated while one is waiting). */
export const DEMO_BOOT_RESET_JOB_ID = 'demo-reset-boot'
/** A reset within this long after the previous one is skipped (boot job + new scheduler). */
export const DEMO_RESET_DEBOUNCE_MS = 60_000

const LOCK_KEY = 'marmot:demo:reset-lock'
const LOCK_TTL_MS = 10 * 60_000

/** Emails of the seeded accounts: the only accounts a demo database may hold. */
export const DEMO_EMAILS: readonly string[] = [
  DEMO_ACCOUNT.email,
  ...DEMO_MEMBERS.map((m) => m.email),
]

export class DemoDatabaseError extends Error {
  readonly accounts: number
  constructor(accounts: number) {
    super(
      `DEMO_MODE refuses to run against this database: it holds ${accounts} account(s) that are ` +
        'not demo accounts, and every demo reset deletes all data. Point DATABASE_URL at an empty ' +
        'database, or set DEMO_MODE_FORCE=true to wipe this one.',
    )
    this.name = 'DemoDatabaseError'
    this.accounts = accounts
  }
}

/** Accounts that are not demo accounts (a real install has at least its superadmin). */
export async function countNonDemoAccounts(payload: Payload): Promise<number> {
  const { totalDocs } = await payload.count({
    collection: 'users',
    where: { email: { not_in: [...DEMO_EMAILS] } },
    overrideAccess: true,
  })
  return totalDocs
}

/** Throws `DemoDatabaseError` for a database with non-demo accounts, unless forced. */
export async function assertDemoDatabase(
  payload: Payload,
  { force = env.DEMO_MODE_FORCE }: { force?: boolean } = {},
): Promise<void> {
  const accounts = await countNonDemoAccounts(payload)
  if (accounts === 0) return
  if (force) {
    log.warn({ accounts }, 'DEMO_MODE_FORCE: wiping a database with non-demo accounts')
    return
  }
  throw new DemoDatabaseError(accounts)
}

/**
 * Startup check (Payload `onInit`, every process): throws `DemoDatabaseError` for a database with
 * non-demo accounts unless `DEMO_MODE_FORCE` is set. A database whose schema does not exist yet
 * (first boot, migrations still running) is empty and passes.
 */
export async function refuseNonDemoDatabase(payload: Payload): Promise<void> {
  try {
    await assertDemoDatabase(payload)
  } catch (err) {
    if (err instanceof DemoDatabaseError) {
      log.fatal({ accounts: err.accounts }, err.message)
      throw err
    }
    log.warn({ err }, 'demo mode: could not inspect the database yet; the first reset checks again')
  }
}

/**
 * Deletion order. Rows that reference others with a required (NOT NULL) column or array row go
 * before what they reference; Postgres would otherwise refuse the `SET NULL` of the foreign key.
 * Collections not listed here are deleted after these, in reverse registry order, and the accounts
 * and organizations last.
 */
const WIPE_FIRST = [
  'payload-locked-documents',
  'payload-preferences',
  'heartbeats',
  'push-events',
  'monitor-location-states',
  'stat-minutely',
  'stat-hourly',
  'stat-daily',
  'stat-location-hourly',
  'notification-sent-history',
  'monitor-incidents',
  'audit-logs',
  'webhook-deliveries',
  'webhook-endpoints',
  'subscriber-deliveries',
  'subscriber-notifications',
  'status-page-subscribers',
  'status-page-viewers',
  'incidents',
  'maintenance-occurrences',
  'maintenance',
  'templates',
  'status-pages',
  'monitors',
]
const WIPE_LAST = ['auth-accounts', 'users', 'organizations']
/** Never deleted: the migration journal. */
const KEEP = new Set(['payload-migrations'])

export function wipeOrder(slugs: readonly string[]): string[] {
  const present = new Set(slugs)
  const listed = new Set([...WIPE_FIRST, ...WIPE_LAST])
  const rest = [...slugs].reverse().filter((slug) => !listed.has(slug) && !KEEP.has(slug))
  return [...WIPE_FIRST, ...rest, ...WIPE_LAST].filter((slug) => present.has(slug))
}

/** Delete every row of every collection (but the migrations), in batches. Returns counts. */
export async function wipeDatabase(
  payload: Payload,
  { batchSize }: { batchSize?: number } = {},
): Promise<Record<string, number>> {
  const deleted: Record<string, number> = {}
  for (const slug of wipeOrder(payload.config.collections.map((c) => c.slug))) {
    deleted[slug] = await deleteInBatches(payload, slug as CollectionSlug, {}, { batchSize })
  }
  return deleted
}

export interface ResetOptions {
  now?: Date
  /** Wipe a database with non-demo accounts (`DEMO_MODE_FORCE` by default). */
  force?: boolean
  batchSize?: number
  /** Days of synthetic history (default 90). */
  historyDays?: number
}

export interface ResetResult {
  deleted: Record<string, number>
  seeded: SeedResult
  durationMs: number
}

/** Wipe and reseed. Checks the database first; never call it outside demo mode. */
export async function resetDemoData(
  payload: Payload,
  options: ResetOptions = {},
): Promise<ResetResult> {
  const started = Date.now()
  await assertDemoDatabase(payload, { force: options.force })
  const deleted = await wipeDatabase(payload, { batchSize: options.batchSize })
  const seeded = await seedDemoData(payload, {
    now: options.now ?? new Date(),
    historyDays: options.historyDays,
  })
  const durationMs = Date.now() - started
  log.info({ durationMs, history: seeded.history }, 'demo data reset')
  return { deleted, seeded, durationMs }
}

/** When the dataset was last seeded (the demo organization's creation), or `null`. */
export async function lastDemoReset(payload: Payload): Promise<Date | null> {
  const { docs } = await payload.find({
    collection: 'organizations',
    where: { slug: { equals: DEMO_ORGANIZATION_SLUG } },
    limit: 1,
    depth: 0,
    overrideAccess: true,
    select: { createdAt: true },
  })
  const createdAt = docs[0]?.createdAt
  return createdAt ? new Date(createdAt) : null
}

export interface DemoJobDeps {
  /** Rebuild the check schedulers after a reset (the worker passes `resyncAll`). */
  resync?: (payload: Payload) => Promise<unknown>
  /** Run `fn` holding a cross-worker lock; `null` when another worker holds it. */
  withLock?: <T>(fn: () => Promise<T>) => Promise<T | null>
}

/** Processor of `demo-reset` jobs (from the maintenance queue's processor). */
export async function processDemoResetJob(
  payload: Payload,
  job: Pick<Job, 'id' | 'name'>,
  deps: DemoJobDeps = {},
): Promise<ResetResult | { skipped: string }> {
  // A scheduler left behind by an instance that was a demo once must never wipe real data.
  if (!isDemoMode()) return { skipped: 'demo mode is off' }
  const run = async (): Promise<ResetResult | { skipped: string }> => {
    const last = await lastDemoReset(payload)
    if (last && Date.now() - last.getTime() < DEMO_RESET_DEBOUNCE_MS) {
      return { skipped: 'reset less than a minute ago' }
    }
    const result = await resetDemoData(payload)
    if (deps.resync) await deps.resync(payload)
    return result
  }
  const result = deps.withLock ? await deps.withLock(run) : await run()
  if (result === null) return { skipped: 'another worker is resetting' }
  if ('skipped' in result) log.info({ jobId: job.id, reason: result.skipped }, 'demo reset skipped')
  return result
}

/** `withLock` over a Redis client (`SET NX PX`, released only by its owner). */
export const redisLock =
  (client: Redis) =>
  async <T>(fn: () => Promise<T>): Promise<T | null> => {
    const token = `${process.pid}-${Date.now()}-${Math.random()}`
    const acquired = await client.set(LOCK_KEY, token, 'PX', LOCK_TTL_MS, 'NX')
    if (acquired !== 'OK') return null
    try {
      return await fn()
    } finally {
      await client
        .eval(
          "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) end return 0",
          1,
          LOCK_KEY,
          token,
        )
        .catch(() => undefined)
    }
  }

/** Upsert the `demo-reset` scheduler (idempotent; the interval follows the configuration). */
export async function scheduleDemoReset(queue: Queue): Promise<void> {
  const every = demoResetIntervalMs()
  await queue.upsertJobScheduler(
    DEMO_RESET_JOB_NAME,
    { every },
    { name: DEMO_RESET_JOB_NAME, opts: { removeOnComplete: 10, removeOnFail: 20 } },
  )
  log.info({ everyMs: every }, 'demo reset scheduler upserted')
}

/** Enqueue the boot reset (deduplicated by job id while one is waiting or running). */
export async function enqueueBootReset(queue: Queue): Promise<void> {
  await queue.add(
    DEMO_RESET_JOB_NAME,
    {},
    { jobId: DEMO_BOOT_RESET_JOB_ID, removeOnComplete: true, removeOnFail: true },
  )
}

/** Remove the schedulers of a former demo (no-op when there are none). */
export async function removeDemoSchedulers(queue: Queue): Promise<void> {
  await queue.removeJobScheduler(DEMO_RESET_JOB_NAME)
}

/** Time of the next scheduled reset, from the scheduler (`null` when unknown). */
export async function nextScheduledReset(queue: Queue): Promise<Date | null> {
  const scheduler = await queue.getJobScheduler(DEMO_RESET_JOB_NAME)
  const next = scheduler?.next
  return typeof next === 'number' && Number.isFinite(next) ? new Date(next) : null
}
