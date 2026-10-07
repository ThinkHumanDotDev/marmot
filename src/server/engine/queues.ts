import { Queue, Worker, type Processor, type WorkerOptions } from 'bullmq'
import type { Redis } from 'ioredis'

import type { OnDemandCheckResult } from '@/lib/on-demand-check'
import type { Monitor } from '@/payload-types'
import { createRedis } from '@/server/redis'
import { QUEUE_NAMES, QUEUE_PREFIX, type CheckJobName } from './names'

/** Payload of a `check` job on the checks queue. */
export interface CheckJobData {
  monitorId: string
}

/** Payload of a `manual-check` job: run a saved monitor now. */
export interface ManualCheckJobData {
  monitorId: string
  /** Store the result as a heartbeat (`trigger: manual`) and feed the state machine. */
  record: boolean
  /** Epoch ms after which a job that has not started yet is dropped (nobody waits for it any more). */
  deadline: number
}

/** Payload of an `adhoc-check` job: run an unsaved monitor configuration, store nothing. */
export interface AdhocCheckJobData {
  organizationId: string
  /** Validated monitor form values (`monitorFormSchema`). */
  monitor: Partial<Monitor>
  deadline: number
}

export type ChecksQueueJobData = CheckJobData | ManualCheckJobData | AdhocCheckJobData

/** Scheduled checks return nothing; on-demand checks return their result to the waiting request. */
export type ChecksQueueResult = OnDemandCheckResult | void

export type ChecksQueue = Queue<ChecksQueueJobData, ChecksQueueResult, CheckJobName>

/**
 * Queue/Worker factories over `createRedis()`. BullMQ wants a dedicated blocking connection per
 * worker and `maxRetriesPerRequest: null`, both of which `createRedis` provides.
 *
 * Keys are namespaced with `prefix` (default `marmot`; tests use a random prefix and
 * `queue.obliterate()` so parallel suites never share state).
 */
export interface QueueFactoryOptions {
  connection?: Redis
  prefix?: string
}

export function createQueue<D = unknown, R = void, N extends string = string>(
  name: string,
  options: QueueFactoryOptions = {},
): Queue<D, R, N> {
  return new Queue<D, R, N>(name, {
    connection: options.connection ?? createRedis(),
    prefix: options.prefix ?? QUEUE_PREFIX,
  })
}

export function createWorker<D = unknown, R = void, N extends string = string>(
  name: string,
  processor: Processor<D, R, N>,
  options: QueueFactoryOptions & Pick<WorkerOptions, 'concurrency' | 'autorun'> = {},
): Worker<D, R, N> {
  // Only pass keys that are set: BullMQ spreads these over its defaults, so an explicit
  // `autorun: undefined` would disable autorun.
  const workerOptions: WorkerOptions = {
    connection: options.connection ?? createRedis(),
    prefix: options.prefix ?? QUEUE_PREFIX,
  }
  if (options.concurrency !== undefined) workerOptions.concurrency = options.concurrency
  if (options.autorun !== undefined) workerOptions.autorun = options.autorun
  return new Worker<D, R, N>(name, processor, workerOptions)
}

let checksQueue: ChecksQueue | undefined

/** Process-wide checks queue (lazy; shares one Redis connection). */
export function getChecksQueue(): ChecksQueue {
  checksQueue ??= createQueue<ChecksQueueJobData, ChecksQueueResult, CheckJobName>(
    QUEUE_NAMES.checks,
  )
  return checksQueue
}

/** Close the shared queue (and its connection). Safe to call when nothing was opened. */
export async function closeChecksQueue(): Promise<void> {
  const queue = checksQueue
  checksQueue = undefined
  if (queue) {
    await queue.close()
  }
}
