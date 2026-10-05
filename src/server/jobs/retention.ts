/**
 * Retention job: keeps the database small by pruning expired time-series rows.
 *
 * Inspired by Uptime Kuma 2.x `server/jobs/clear-old-data.js` and the pruning in
 * `server/uptime-calculator.js` (MIT License, Copyright (c) 2021 Louis Lam,
 * https://github.com/louislam/uptime-kuma). See THIRD_PARTY_NOTICES.md.
 *
 * Policy:
 * - `stat-minutely`      older than 24 hours
 * - `stat-hourly`        older than 30 days
 * - `stat-daily`         older than `KEEP_DATA_PERIOD_DAYS` (skipped when < 1, like Uptime Kuma)
 * - `heartbeats`         non-important beats older than 24 hours, important beats older than
 *                        `KEEP_DATA_PERIOD_DAYS` (only when the engine's collection exists)
 *
 * Runs hourly as a BullMQ job scheduler on the `marmot:maintenance` queue.
 */
import { Queue, Worker, type ConnectionOptions, type Job } from 'bullmq'
import type { CollectionSlug, Payload, Where } from 'payload'

import { env } from '@/env'
import { childLogger } from '@/lib/logger'
import { QUEUE_NAMES } from '@/server/engine'
import { createRedis } from '@/server/redis'
import { getDailyKey, getHourlyKey, getMinutelyKey } from '@/server/stats/uptime-calculator'

const log = childLogger('retention')

export const RETENTION_JOB_NAME = 'retention'
export const RETENTION_INTERVAL_MS = 60 * 60 * 1000

export const MINUTELY_KEEP_SECONDS = 24 * 60 * 60
export const HOURLY_KEEP_SECONDS = 30 * 24 * 60 * 60
export const HEARTBEAT_KEEP_SECONDS = 24 * 60 * 60
/** Security audit rows (`audit-logs`) are kept for a year regardless of `KEEP_DATA_PERIOD_DAYS`. */
export const AUDIT_LOG_KEEP_DAYS = 365

/** Slug of the engine's raw heartbeat collection (delivered by the engine issue). */
const HEARTBEATS_SLUG = 'heartbeats'
const AUDIT_LOGS_SLUG = 'audit-logs'

export type RetentionOptions = {
  /** Days to keep daily aggregates and important heartbeats. Defaults to `KEEP_DATA_PERIOD_DAYS`. */
  keepDataPeriodDays?: number
}

export type RetentionResult = {
  minutely: number
  hourly: number
  daily: number
  heartbeats: number
  importantHeartbeats: number
  auditLogs: number
}

const subtractSeconds = (date: Date, seconds: number): Date =>
  new Date(date.getTime() - seconds * 1000)

/** Cutoff bucket keys used by `runRetention`; rows with `timestamp < cutoff` are deleted. */
export function retentionCutoffs(now: Date, keepDataPeriodDays: number) {
  return {
    minutely: getMinutelyKey(subtractSeconds(now, MINUTELY_KEEP_SECONDS)),
    hourly: getHourlyKey(subtractSeconds(now, HOURLY_KEEP_SECONDS)),
    daily: getDailyKey(subtractSeconds(now, keepDataPeriodDays * 86400)),
    heartbeats: subtractSeconds(now, HEARTBEAT_KEEP_SECONDS),
    importantHeartbeats: subtractSeconds(now, keepDataPeriodDays * 86400),
    auditLogs: subtractSeconds(now, AUDIT_LOG_KEEP_DAYS * 86400),
  }
}

async function deleteWhere(payload: Payload, collection: CollectionSlug, where: Where) {
  const result = await payload.delete({ collection, where, depth: 0 })
  if (result.errors.length > 0) {
    log.warn({ collection, errors: result.errors.length }, 'some rows could not be deleted')
  }
  return result.docs.length
}

const hasCollection = (payload: Payload, slug: string): slug is CollectionSlug =>
  Object.prototype.hasOwnProperty.call(payload.collections, slug)

/**
 * Prune expired rows. `now` is injectable for tests. Returns how many rows were deleted per
 * collection.
 */
export async function runRetention(
  payload: Payload,
  now: Date = new Date(),
  opts: RetentionOptions = {},
): Promise<RetentionResult> {
  const keepDays = opts.keepDataPeriodDays ?? env.KEEP_DATA_PERIOD_DAYS
  const cutoffs = retentionCutoffs(now, keepDays)
  const result: RetentionResult = {
    minutely: 0,
    hourly: 0,
    daily: 0,
    heartbeats: 0,
    importantHeartbeats: 0,
    auditLogs: 0,
  }

  result.minutely = await deleteWhere(payload, 'stat-minutely', {
    timestamp: { less_than: cutoffs.minutely },
  })
  result.hourly = await deleteWhere(payload, 'stat-hourly', {
    timestamp: { less_than: cutoffs.hourly },
  })

  const longTermEnabled = keepDays >= 1
  if (longTermEnabled) {
    result.daily = await deleteWhere(payload, 'stat-daily', {
      timestamp: { less_than: cutoffs.daily },
    })
  } else {
    log.info({ keepDays }, 'long-term retention disabled (KEEP_DATA_PERIOD_DAYS < 1)')
  }

  if (hasCollection(payload, HEARTBEATS_SLUG)) {
    result.heartbeats = await deleteWhere(payload, HEARTBEATS_SLUG, {
      and: [
        { time: { less_than: cutoffs.heartbeats.toISOString() } },
        { or: [{ important: { equals: false } }, { important: { exists: false } }] },
      ],
    })
    if (longTermEnabled) {
      result.importantHeartbeats = await deleteWhere(payload, HEARTBEATS_SLUG, {
        and: [
          { time: { less_than: cutoffs.importantHeartbeats.toISOString() } },
          { important: { equals: true } },
        ],
      })
    }
  }

  if (hasCollection(payload, AUDIT_LOGS_SLUG)) {
    result.auditLogs = await deleteWhere(payload, AUDIT_LOGS_SLUG, {
      createdAt: { less_than: cutoffs.auditLogs.toISOString() },
    })
  }

  log.info({ ...result, keepDays }, 'retention run finished')
  return result
}

/**
 * Upsert the hourly `retention` job scheduler on the given queue (expected:
 * `QUEUE_NAMES.maintenance`). Idempotent; safe to call on every worker boot.
 */
export async function scheduleRetention(queue: Queue): Promise<void> {
  await queue.upsertJobScheduler(
    RETENTION_JOB_NAME,
    { every: RETENTION_INTERVAL_MS },
    {
      name: RETENTION_JOB_NAME,
      opts: { removeOnComplete: 24, removeOnFail: 100 },
    },
  )
  log.info({ queue: queue.name, everyMs: RETENTION_INTERVAL_MS }, 'retention scheduler upserted')
}

/** Processor for the maintenance queue: handles `retention` jobs, ignores other job names. */
export const processRetentionJob =
  (payload: Payload) =>
  async (job: Job): Promise<RetentionResult | undefined> => {
    if (job.name !== RETENTION_JOB_NAME) return undefined
    return runRetention(payload)
  }

export type RetentionWorkerOptions = {
  connection?: ConnectionOptions
}

/**
 * Start a BullMQ worker on the maintenance queue that runs `retention` jobs. Returns the
 * worker so the caller can `close()` it on shutdown. If the engine already runs a worker on
 * `QUEUE_NAMES.maintenance`, prefer dispatching to `processRetentionJob(payload)` from that
 * worker instead of starting a second one.
 */
export function startRetentionWorker(
  payload: Payload,
  options: RetentionWorkerOptions = {},
): Worker {
  const worker = new Worker(QUEUE_NAMES.maintenance, processRetentionJob(payload), {
    connection: options.connection ?? createRedis(),
    concurrency: 1,
  })
  worker.on('failed', (job, err) => {
    log.error({ err, jobId: job?.id, name: job?.name }, 'maintenance job failed')
  })
  return worker
}

/**
 * Convenience for the worker entrypoint: create the maintenance queue, upsert the scheduler and
 * start the worker. Returns a `close()` to call on shutdown.
 */
export async function startRetention(payload: Payload): Promise<{ close: () => Promise<void> }> {
  const queue = new Queue(QUEUE_NAMES.maintenance, { connection: createRedis() })
  await scheduleRetention(queue)
  const worker = startRetentionWorker(payload)
  return {
    close: async () => {
      await worker.close()
      await queue.close()
    },
  }
}
