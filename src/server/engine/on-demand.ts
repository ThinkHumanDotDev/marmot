/**
 * On-demand checks (#98): "Check now" on a saved monitor and "Test" of an unsaved configuration.
 *
 * The web process never connects to a monitor target itself. Route handlers enqueue a job on the
 * checks queue (`manual-check` / `adhoc-check`, LIFO so it overtakes the scheduled backlog) and wait
 * for the worker's return value through BullMQ `QueueEvents`. The worker runs the check exactly like
 * a scheduled one (`runCheck`: monitor timeout, outbound address guard, proxies), and
 *
 * - `manual-check` with `record: true` feeds the result through the heartbeat state machine and
 *   stores it with `trigger: manual` (realtime, stats and notifications follow as for any beat);
 *   with `record: false` it only reports what the check saw;
 * - `adhoc-check` never stores anything.
 *
 * This module is the web side (enqueue, wait); the processors live in `on-demand-jobs.ts`.
 *
 * Jobs carry a `deadline`: a job the worker picks up after nobody waits for it any more (worker down,
 * long backlog) is dropped instead of producing a surprise heartbeat minutes later.
 */
import { QueueEvents, type Job } from 'bullmq'

import { childLogger } from '@/lib/logger'
import type { OnDemandCheckResult } from '@/lib/on-demand-check'
import type { Monitor } from '@/payload-types'
import { checkTimeoutMs } from '@/server/monitor-types/util'
import { createRedis } from '@/server/redis'
import { ADHOC_CHECK_JOB_NAME, MANUAL_CHECK_JOB_NAME, QUEUE_NAMES, QUEUE_PREFIX } from './names'
import {
  getChecksQueue,
  type AdhocCheckJobData,
  type ChecksQueue,
  type ManualCheckJobData,
} from './queues'

const log = childLogger('engine:on-demand')

/** Time allowed on top of the check timeout for the job to reach a worker and report back. */
export const ON_DEMAND_QUEUE_GRACE_MS = 10_000

/** Upper bound of how long a request waits for a result. */
export const ON_DEMAND_MAX_WAIT_MS = 120_000

/** Finished on-demand jobs (and their data, which may hold credentials) stay this long in Redis. */
const KEEP_FINISHED_SECONDS = 60

/** Why the worker did not run an on-demand job. */
export type OnDemandSkipReason = 'expired' | 'not-found' | 'inactive' | 'not-applicable'

export const ON_DEMAND_SKIP_PREFIX = 'on-demand-skipped:'

/** Thrown by the processors; BullMQ fails the job (no retries) and the waiter reads the reason. */
export class OnDemandSkipError extends Error {
  constructor(readonly reason: OnDemandSkipReason) {
    super(`${ON_DEMAND_SKIP_PREFIX}${reason}`)
    this.name = 'OnDemandSkipError'
  }
}

/** How long to wait for an on-demand check of `monitor`: its timeout plus the queue grace. */
export function onDemandWaitMs(monitor: Pick<Monitor, 'timeout' | 'interval'>): number {
  return Math.min(ON_DEMAND_MAX_WAIT_MS, checkTimeoutMs(monitor) + ON_DEMAND_QUEUE_GRACE_MS)
}

// ---- Web side: enqueue and wait ---------------------------------------------------------------

export interface OnDemandTransport {
  queue: ChecksQueue
  events: QueueEvents
}

let transport: OnDemandTransport | undefined

/** Queue + QueueEvents the route handlers use (lazy; the events need their own connection). */
export function getOnDemandTransport(): OnDemandTransport {
  transport ??= {
    queue: getChecksQueue(),
    events: new QueueEvents(QUEUE_NAMES.checks, {
      connection: createRedis(),
      prefix: QUEUE_PREFIX,
    }),
  }
  return transport
}

/** Replace the transport (tests use a queue with a random prefix). `undefined` resets it. */
export function setOnDemandTransport(next: OnDemandTransport | undefined): void {
  transport = next
}

export type OnDemandJob =
  | { name: typeof MANUAL_CHECK_JOB_NAME; data: ManualCheckJobData; dedupeKey: string }
  | { name: typeof ADHOC_CHECK_JOB_NAME; data: AdhocCheckJobData; dedupeKey?: undefined }

/**
 * Enqueue an on-demand check. A `manual-check` is deduplicated per monitor while one is waiting or
 * running: the second request waits for the first job's result instead of checking twice.
 */
export async function enqueueOnDemandCheck(
  job: OnDemandJob,
  ttlMs: number,
  t: OnDemandTransport = getOnDemandTransport(),
): Promise<Job> {
  return t.queue.add(job.name, job.data, {
    lifo: true,
    attempts: 1,
    removeOnComplete: { age: KEEP_FINISHED_SECONDS },
    removeOnFail: { age: KEEP_FINISHED_SECONDS },
    ...(job.dedupeKey ? { deduplication: { id: job.dedupeKey, ttl: ttlMs } } : {}),
  }) as Promise<Job>
}

export type OnDemandOutcome =
  | { kind: 'done'; result: OnDemandCheckResult }
  | { kind: 'skipped'; reason: OnDemandSkipReason }
  | { kind: 'timeout' }
  | { kind: 'failed'; message: string }

/** Wait for an enqueued on-demand job; never throws. */
export async function waitForOnDemandCheck(
  job: Job,
  waitMs: number,
  t: OnDemandTransport = getOnDemandTransport(),
): Promise<OnDemandOutcome> {
  try {
    const result = (await job.waitUntilFinished(t.events, waitMs)) as OnDemandCheckResult
    return { kind: 'done', result }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (message.startsWith(ON_DEMAND_SKIP_PREFIX)) {
      return {
        kind: 'skipped',
        reason: message.slice(ON_DEMAND_SKIP_PREFIX.length) as OnDemandSkipReason,
      }
    }
    if (message.includes('timed out before finishing')) return { kind: 'timeout' }
    log.warn({ err: message, jobId: job.id }, 'on-demand check failed')
    return { kind: 'failed', message }
  }
}

/** Close the shared QueueEvents connection (the queue itself belongs to `closeChecksQueue`). */
export async function closeOnDemandTransport(): Promise<void> {
  const current = transport
  transport = undefined
  if (current) await current.events.close().catch(() => undefined)
}
