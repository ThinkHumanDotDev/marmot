/**
 * The `marmot:maintenance` BullMQ queue and the delayed "wake-up" jobs of maintenance windows.
 *
 * Transitions and reminders are not polled: whenever `syncMaintenance()` plans an occurrence it
 * enqueues one delayed `maintenance-wakeup` job per future instant that matters (planned start,
 * planned end, each reminder). The job re-runs `syncMaintenance()` for that maintenance at that
 * instant, which applies whatever is due. Job ids include the instant, so re-planning is idempotent
 * and a stale job (the schedule changed since) finds nothing to do. The every-minute
 * `maintenance-status` job stays as a reconciler for jobs lost with Redis.
 */
import type { Queue } from 'bullmq'

import { childLogger } from '@/lib/logger'
import { QUEUE_NAMES } from '@/server/engine/names'
import { createQueue, type QueueFactoryOptions } from '@/server/engine/queues'

const log = childLogger('maintenance:queue')

export const MAINTENANCE_WAKEUP_JOB_NAME = 'maintenance-wakeup'

export interface MaintenanceWakeupData {
  maintenanceId: string
  /** Epoch ms the job was planned for (the processor never evaluates earlier than this). */
  at: number
}

/** BullMQ custom job ids may not contain `:`. */
export const maintenanceWakeupJobId = (maintenanceId: string | number, at: number): string =>
  `maintenance-wakeup-${maintenanceId}-${at}`

/** How long the web process waits for Redis before giving up (requests must stay responsive). */
const REDIS_TIMEOUT_MS = 5_000

let maintenanceQueue: Queue | undefined

/** Process-wide queue for the `maintenance` BullMQ queue (lazy; shares one Redis connection). */
export function getMaintenanceQueue(options: QueueFactoryOptions = {}): Queue {
  maintenanceQueue ??= createQueue(QUEUE_NAMES.maintenance, options)
  return maintenanceQueue
}

export async function closeMaintenanceQueue(): Promise<void> {
  const queue = maintenanceQueue
  maintenanceQueue = undefined
  if (queue) await queue.close()
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Redis did not answer within ${ms}ms`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

/**
 * Enqueue a delayed wake-up for each future instant (duplicates and past instants are skipped).
 * Returns the ids of the jobs it asked for. Never throws: the minute reconciler covers failures.
 */
export async function scheduleMaintenanceWakeups(
  maintenanceId: string | number,
  instants: readonly number[],
  options: { queue?: Queue; now?: number } = {},
): Promise<string[]> {
  const now = options.now ?? Date.now()
  const future = [...new Set(instants.filter((at) => Number.isFinite(at) && at > now))].sort(
    (a, b) => a - b,
  )
  if (future.length === 0) return []
  const ids: string[] = []
  try {
    const queue = options.queue ?? getMaintenanceQueue()
    for (const at of future) {
      const jobId = maintenanceWakeupJobId(maintenanceId, at)
      const data: MaintenanceWakeupData = { maintenanceId: String(maintenanceId), at }
      await withTimeout(
        queue.add(MAINTENANCE_WAKEUP_JOB_NAME, data, {
          jobId,
          delay: at - now,
          removeOnComplete: 100,
          removeOnFail: 100,
        }),
        REDIS_TIMEOUT_MS,
      )
      ids.push(jobId)
    }
  } catch (err) {
    log.warn({ err, maintenanceId }, 'failed to schedule maintenance wake-ups')
  }
  return ids
}
