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
 * - `stat-location-hourly` older than 30 days (per-location series of multi-location monitors, #92)
 * - `stat-daily`         older than the `keepDataPeriodDays` instance setting (default
 *                        `KEEP_DATA_PERIOD_DAYS`; skipped when < 1, like Uptime Kuma)
 * - `heartbeats`         non-important beats older than 24 hours, important beats older than
 *                        `keepDataPeriodDays` (only when the engine's collection exists)
 * - `status-page-subscribers` self sign-ups never confirmed within 72 hours
 * - `subscriber-deliveries` older than 90 days (the per-subscriber delivery log)
 * - `webhook-deliveries` older than `WEBHOOK_DELIVERY_RETENTION_DAYS` (default 14)
 * - `audit-logs`         older than `AUDIT_LOG_RETENTION_DAYS` (default 365; 0 keeps them forever)
 *
 * Rows are deleted in batches of `DELETE_BATCH_SIZE` (`deleteInBatches`), so a large backlog (a big
 * install, a worker that was down, a lowered retention period) never has to fit in memory (#237).
 * The telemetry and log collections have no delete hooks and are removed straight through the
 * database adapter; unconfirmed subscribers go through `payload.delete` because their
 * `beforeDelete` hook removes their delivery rows.
 *
 * Runs hourly as a BullMQ job scheduler on the `marmot:maintenance` queue.
 */
import { Queue, Worker, type ConnectionOptions, type Job } from 'bullmq'
import type { CollectionSlug, Payload, Where } from 'payload'

import { deleteInBatches } from '@/db/delete-in-batches'
import { env } from '@/env'
import { UNCONFIRMED_SUBSCRIBER_TTL_HOURS } from '@/lib/status-page-subscribers'
import { childLogger } from '@/lib/logger'
import { QUEUE_NAMES } from '@/server/engine'
import { createRedis } from '@/server/redis'
import { getInstanceSettings } from '@/server/settings'
import { getDailyKey, getHourlyKey, getMinutelyKey } from '@/server/stats/uptime-calculator'

const log = childLogger('retention')

export const RETENTION_JOB_NAME = 'retention'
export const RETENTION_INTERVAL_MS = 60 * 60 * 1000

export const MINUTELY_KEEP_SECONDS = 24 * 60 * 60
export const HOURLY_KEEP_SECONDS = 30 * 24 * 60 * 60
export const HEARTBEAT_KEEP_SECONDS = 24 * 60 * 60
/**
 * Default retention of audit rows (`audit-logs`), independent of `KEEP_DATA_PERIOD_DAYS`; configured
 * with `AUDIT_LOG_RETENTION_DAYS` (0 keeps them forever).
 */
export const AUDIT_LOG_KEEP_DAYS = 365
/** Per-subscriber delivery log rows of status page notifications. */
export const SUBSCRIBER_DELIVERY_KEEP_DAYS = 90

/** Slug of the engine's raw heartbeat collection (delivered by the engine issue). */
const HEARTBEATS_SLUG = 'heartbeats'
const AUDIT_LOGS_SLUG = 'audit-logs'

export type RetentionOptions = {
  /** Days to keep daily aggregates and important heartbeats. Defaults to `KEEP_DATA_PERIOD_DAYS`. */
  keepDataPeriodDays?: number
  /** Days to keep audit rows (0 = forever). Defaults to `AUDIT_LOG_RETENTION_DAYS`. */
  auditLogRetentionDays?: number
  /** Days to keep the webhook delivery log. Defaults to `WEBHOOK_DELIVERY_RETENTION_DAYS`. */
  webhookDeliveryRetentionDays?: number
  /** Rows deleted per batch. Defaults to `DELETE_BATCH_SIZE`; tests pass a small value. */
  batchSize?: number
}

export type RetentionResult = {
  minutely: number
  hourly: number
  locationHourly: number
  daily: number
  heartbeats: number
  importantHeartbeats: number
  auditLogs: number
  unconfirmedSubscribers: number
  subscriberDeliveries: number
  webhookDeliveries: number
}

const subtractSeconds = (date: Date, seconds: number): Date =>
  new Date(date.getTime() - seconds * 1000)

/** Cutoff bucket keys used by `runRetention`; rows with `timestamp < cutoff` are deleted. */
export function retentionCutoffs(
  now: Date,
  keepDataPeriodDays: number,
  auditLogRetentionDays: number = AUDIT_LOG_KEEP_DAYS,
) {
  return {
    minutely: getMinutelyKey(subtractSeconds(now, MINUTELY_KEEP_SECONDS)),
    hourly: getHourlyKey(subtractSeconds(now, HOURLY_KEEP_SECONDS)),
    daily: getDailyKey(subtractSeconds(now, keepDataPeriodDays * 86400)),
    heartbeats: subtractSeconds(now, HEARTBEAT_KEEP_SECONDS),
    importantHeartbeats: subtractSeconds(now, keepDataPeriodDays * 86400),
    auditLogs: subtractSeconds(now, auditLogRetentionDays * 86400),
    unconfirmedSubscribers: subtractSeconds(now, UNCONFIRMED_SUBSCRIBER_TTL_HOURS * 3600),
    subscriberDeliveries: subtractSeconds(now, SUBSCRIBER_DELIVERY_KEEP_DAYS * 86400),
  }
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
  const auditDays = opts.auditLogRetentionDays ?? env.AUDIT_LOG_RETENTION_DAYS
  const cutoffs = retentionCutoffs(now, keepDays, auditDays)
  const { batchSize } = opts
  // Telemetry and logs: no collection hooks to run (see NOT_AUDITED in src/collections/audit.ts).
  const deleteWhere = (collection: CollectionSlug, where: Where) =>
    deleteInBatches(payload, collection, where, { batchSize })
  const result: RetentionResult = {
    minutely: 0,
    hourly: 0,
    locationHourly: 0,
    daily: 0,
    heartbeats: 0,
    importantHeartbeats: 0,
    auditLogs: 0,
    unconfirmedSubscribers: 0,
    subscriberDeliveries: 0,
    webhookDeliveries: 0,
  }

  result.minutely = await deleteWhere('stat-minutely', {
    timestamp: { less_than: cutoffs.minutely },
  })
  result.hourly = await deleteWhere('stat-hourly', {
    timestamp: { less_than: cutoffs.hourly },
  })
  result.locationHourly = await deleteWhere('stat-location-hourly', {
    timestamp: { less_than: cutoffs.hourly },
  })

  const longTermEnabled = keepDays >= 1
  if (longTermEnabled) {
    result.daily = await deleteWhere('stat-daily', {
      timestamp: { less_than: cutoffs.daily },
    })
  } else {
    log.info({ keepDays }, 'long-term retention disabled (KEEP_DATA_PERIOD_DAYS < 1)')
  }

  if (hasCollection(payload, HEARTBEATS_SLUG)) {
    result.heartbeats = await deleteWhere(HEARTBEATS_SLUG, {
      and: [
        { time: { less_than: cutoffs.heartbeats.toISOString() } },
        { or: [{ important: { equals: false } }, { important: { exists: false } }] },
      ],
    })
    if (longTermEnabled) {
      result.importantHeartbeats = await deleteWhere(HEARTBEATS_SLUG, {
        and: [
          { time: { less_than: cutoffs.importantHeartbeats.toISOString() } },
          { important: { equals: true } },
        ],
      })
    }
  }

  if (hasCollection(payload, AUDIT_LOGS_SLUG) && auditDays >= 1) {
    result.auditLogs = await deleteWhere(AUDIT_LOGS_SLUG, {
      createdAt: { less_than: cutoffs.auditLogs.toISOString() },
    })
  }

  if (hasCollection(payload, 'status-page-subscribers')) {
    // Hooks run: `beforeDelete` removes the subscriber's delivery rows.
    result.unconfirmedSubscribers = await deleteInBatches(
      payload,
      'status-page-subscribers',
      {
        and: [
          { source: { equals: 'self_signup' } },
          { confirmedAt: { exists: false } },
          { createdAt: { less_than: cutoffs.unconfirmedSubscribers.toISOString() } },
        ],
      },
      { batchSize, hooks: true },
    )
    result.subscriberDeliveries = await deleteWhere('subscriber-deliveries', {
      createdAt: { less_than: cutoffs.subscriberDeliveries.toISOString() },
    })
  }

  if (hasCollection(payload, 'webhook-deliveries')) {
    const days = opts.webhookDeliveryRetentionDays ?? env.WEBHOOK_DELIVERY_RETENTION_DAYS
    result.webhookDeliveries = await deleteWhere('webhook-deliveries', {
      createdAt: { less_than: subtractSeconds(now, days * 86400).toISOString() },
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
    // The `keepDataPeriodDays` instance setting (defaulting to `KEEP_DATA_PERIOD_DAYS`) decides.
    const { keepDataPeriodDays } = await getInstanceSettings(payload)
    return runRetention(payload, new Date(), { keepDataPeriodDays })
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
