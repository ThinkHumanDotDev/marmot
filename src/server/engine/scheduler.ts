import type { Payload, PayloadRequest } from 'payload'

import { afterCommit } from '@/db/after-commit'
import { PUSH_CRON_CHECK_SECONDS } from '@/lib/push-schedule'
import { env } from '@/env'
import { isMultiLocation, isRemoteMonitor } from '@/lib/probe-locations'
import { childLogger } from '@/lib/logger'
import type { Monitor } from '@/payload-types'
import { emitMonitorDeleted, emitMonitorUpdated } from '@/server/realtime/emitter'
import { populateMonitorTags, relationId } from '@/server/realtime/serialize'
import { nextIntervalSeconds, type MonitorSettings } from './beat'
import { CHECK_JOB_NAME, monitorSchedulerId } from './names'
import { getChecksQueue, type ChecksQueue } from './queues'

const log = childLogger('engine:scheduler')

/** How long collection hooks wait for Redis before giving up (the web process must stay responsive). */
const HOOK_REDIS_TIMEOUT_MS = 5_000

/** Monitor fields the scheduler needs; accepts a full document or the status-cache subset. */
export type SchedulableMonitor = Pick<Monitor, 'id' | 'interval' | 'retryInterval'> &
  Partial<Pick<Monitor, 'type' | 'pushSchedule' | 'locations' | 'includeLocal'>> & {
    status?: Pick<NonNullable<Monitor['status']>, 'lastStatus'> | null
    /**
     * Multi-location monitors (#92): status of the local location, which the workers' cadence
     * follows (`status.lastStatus` is the quorum). Unknown (`interval`) when unset.
     */
    localStatus?: NonNullable<Monitor['status']>['lastStatus']
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
  // Cron push monitors are due at wall-clock times, not every `interval`: check every minute.
  if (monitor.type === 'push' && monitor.pushSchedule === 'cron') {
    return PUSH_CRON_CHECK_SECONDS * 1000
  }
  const settings: MonitorSettings = {
    interval: monitor.interval,
    retryInterval: monitor.retryInterval,
  }
  const status = isMultiLocation(monitor) ? monitor.localStatus : monitor.status?.lastStatus
  return nextIntervalSeconds(status ?? 'up', settings) * 1000
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
 * and re-plans the next job when `every` changes. Monitors checked by a probe location (#91) have
 * no scheduler on the workers: their agents schedule the checks, so any existing one is removed.
 */
export async function syncMonitor(
  monitor: SchedulableMonitor,
  queue: ChecksQueue = getChecksQueue(),
): Promise<void> {
  if (isRemoteMonitor(monitor)) {
    await removeMonitorSchedule(monitor.id, queue)
    return
  }
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

type HookRequest = Pick<PayloadRequest, 'payload' | 'transactionID'>

/**
 * `monitors` afterChange: upsert (active) or remove (paused) the scheduler and emit the realtime
 * delta, **after the operation's transaction commits**. Upserting inside the transaction let an idle
 * worker run the first job before the row was visible; it then hit the not-found path and deleted
 * the brand-new scheduler, so the monitor was never checked. A rolled-back change touches nothing.
 */
export async function syncMonitorAfterCommit(
  req: HookRequest,
  monitor: Monitor,
  queue?: ChecksQueue,
): Promise<void> {
  await afterCommit(req, async () => {
    try {
      if (monitor.active) await syncMonitor(monitor, queue)
      else await removeMonitorSchedule(monitor.id, queue)
      const organizationId = relationId(monitor.organization)
      if (organizationId) {
        // Live lists render tag chips, so the delta carries resolved tags (name, colour, value).
        const [withTags] = await populateMonitorTags(req.payload, [monitor])
        emitMonitorUpdated(organizationId, withTags)
      }
    } catch (err) {
      log.warn({ err, monitorId: monitor.id }, 'failed to sync monitor schedule')
    }
  })
}

/** `monitors` afterDelete: remove the scheduler and emit the deletion once the delete commits. */
export async function removeMonitorAfterCommit(
  req: HookRequest,
  monitor: Pick<Monitor, 'id' | 'organization'>,
  queue?: ChecksQueue,
): Promise<void> {
  await afterCommit(req, async () => {
    try {
      await removeMonitorSchedule(monitor.id, queue)
      const organizationId = relationId(monitor.organization)
      if (organizationId) emitMonitorDeleted(organizationId, monitor.id)
    } catch (err) {
      log.warn({ err, monitorId: monitor.id }, 'failed to remove monitor schedule')
    }
  })
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
    select: {
      interval: true,
      retryInterval: true,
      status: true,
      type: true,
      pushSchedule: true,
      locations: true,
      includeLocal: true,
    },
  })

  // Probe-checked monitors (#91) are scheduled by their agents, not by the workers.
  const local = docs.filter((m) => !isRemoteMonitor(m))
  const wanted = new Map(local.map((m) => [monitorSchedulerId(String(m.id)), m]))

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
