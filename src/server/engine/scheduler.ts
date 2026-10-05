import type { Payload } from 'payload'

import { env } from '@/env'
import { childLogger } from '@/lib/logger'
import type { Monitor } from '@/payload-types'
import { nextIntervalSeconds, type MonitorSettings } from './beat'
import { CHECK_JOB_NAME, monitorSchedulerId } from './names'
import { getChecksQueue, type ChecksQueue } from './queues'

const log = childLogger('engine:scheduler')

/** How long collection hooks wait for Redis before giving up (the web process must stay responsive). */
const HOOK_REDIS_TIMEOUT_MS = 5_000

/** Monitor fields the scheduler needs; accepts a full document or the status-cache subset. */
export type SchedulableMonitor = Pick<Monitor, 'id' | 'interval' | 'retryInterval'> & {
  status?: Pick<NonNullable<Monitor['status']>, 'lastStatus'> | null
}

/** `false` when `MARMOT_DISABLE_ENGINE_HOOKS` is set (int tests without Redis). */
export function engineHooksEnabled(): boolean {
  return !env.MARMOT_DISABLE_ENGINE_HOOKS
}

/**
 * Milliseconds between checks for the monitor's current state: `retryInterval` while PENDING,
 * `interval` otherwise (Uptime Kuma switches `beatInterval` the same way).
 */
export function effectiveIntervalMs(monitor: SchedulableMonitor): number {
  const settings: MonitorSettings = {
    interval: monitor.interval,
    retryInterval: monitor.retryInterval,
  }
  return nextIntervalSeconds(monitor.status?.lastStatus ?? 'up', settings) * 1000
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms)
    promise.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e)
      },
    )
  })
}

/**
 * Create or update the job scheduler of a monitor. Idempotent: BullMQ keeps one scheduler per id
 * and re-plans the next job when `every` changes.
 */
export async function syncMonitor(
  monitor: SchedulableMonitor,
  queue: ChecksQueue = getChecksQueue(),
): Promise<void> {
  const every = effectiveIntervalMs(monitor)
  const id = String(monitor.id)
  await withTimeout(
    queue.upsertJobScheduler(
      monitorSchedulerId(id) as 'check',
      { every },
      {
        name: CHECK_JOB_NAME,
        data: { monitorId: id },
        opts: { removeOnComplete: 100, removeOnFail: 100 },
      },
    ),
    HOOK_REDIS_TIMEOUT_MS,
    `upsertJobScheduler(${monitorSchedulerId(id)})`,
  )
  log.debug({ monitorId: id, every }, 'scheduler upserted')
}

/** Remove the job scheduler of a monitor (paused or deleted). */
export async function removeMonitorSchedule(
  monitorId: string | number,
  queue: ChecksQueue = getChecksQueue(),
): Promise<boolean> {
  const removed = await withTimeout(
    queue.removeJobScheduler(monitorSchedulerId(String(monitorId))),
    HOOK_REDIS_TIMEOUT_MS,
    `removeJobScheduler(${monitorSchedulerId(monitorId)})`,
  )
  log.debug({ monitorId: String(monitorId), removed }, 'scheduler removed')
  return removed
}

/**
 * Worker boot: drop schedulers whose monitor no longer exists or is paused, then upsert one for
 * every active monitor so edits made while the worker was down are picked up.
 */
export async function resyncAll(
  payload: Payload,
  queue: ChecksQueue = getChecksQueue(),
): Promise<{ upserted: number; removed: number }> {
  const { docs } = await payload.find({
    collection: 'monitors',
    where: { active: { equals: true } },
    depth: 0,
    limit: 0,
    pagination: false,
    overrideAccess: true,
    select: { interval: true, retryInterval: true, status: true },
  })

  const wanted = new Map(docs.map((m) => [monitorSchedulerId(String(m.id)), m]))

  let removed = 0
  const existing = await queue.getJobSchedulers(0, -1, true)
  for (const scheduler of existing) {
    if (!wanted.has(scheduler.key)) {
      await queue.removeJobScheduler(scheduler.key)
      removed++
    }
  }

  let upserted = 0
  for (const monitor of wanted.values()) {
    await syncMonitor(monitor as SchedulableMonitor, queue)
    upserted++
  }

  log.info({ upserted, removed }, 'monitor schedulers resynced')
  return { upserted, removed }
}
