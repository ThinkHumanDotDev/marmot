import { Queue, Worker, type Processor, type WorkerOptions } from 'bullmq'
import type { Redis } from 'ioredis'

import { createRedis } from '@/server/redis'
import { QUEUE_NAMES, QUEUE_PREFIX } from './names'

/** Payload of a `check` job on the checks queue. */
export interface CheckJobData {
  monitorId: string
}

export type ChecksQueue = Queue<CheckJobData, void, 'check'>

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
  checksQueue ??= createQueue<CheckJobData, void, 'check'>(QUEUE_NAMES.checks)
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
