/**
 * Maintenance jobs on the `marmot:maintenance` queue (one worker, concurrency 1, so syncs of the
 * same maintenance never overlap):
 *
 * - `maintenance-wakeup` (delayed, one per planned start/end/reminder instant; `queue.ts`): syncs
 *   that maintenance's occurrences at that instant (`syncMaintenance`, `occurrences.ts`).
 * - `maintenance-status` (every minute): reconciler that syncs every maintenance, persists the
 *   statuses that changed and publishes the organization's list to its socket room. It catches
 *   wake-ups lost with Redis and plans the first occurrences of documents saved without hooks.
 * - `retention` (`src/server/jobs/retention.ts`) shares the queue so a single worker serves it.
 * - `probe-health` (every 15 s, `src/server/probes/health.ts`): marks probe locations offline and
 *   online again (#91); the single consumer makes it the only writer of `locations.status`.
 * - `quorum-recompute` (every minute, `src/server/jobs/quorum-recompute.ts`): repairs the status of
 *   multi-location monitors that drifted from their per-location states (#92).
 * - Demo mode only (#159): `demo-reset` (on boot and every `DEMO_RESET_INTERVAL_MINUTES`,
 *   `src/server/demo/reset.ts`) wipes and reseeds the demo dataset; `demo-probes` (every minute,
 *   `src/server/demo/probes.ts`) plays the simulated probe agents.
 */
import type { Job, Queue, Worker } from 'bullmq'
import type { Payload } from 'payload'

import { childLogger } from '@/lib/logger'
import type { Maintenance } from '@/payload-types'
import { isDemoMode } from '@/server/demo/config'
import { DEMO_PROBES_INTERVAL_MS, DEMO_PROBES_JOB_NAME, runDemoProbes } from '@/server/demo/probes'
import {
  DEMO_RESET_JOB_NAME,
  enqueueBootReset,
  processDemoResetJob,
  redisLock,
  removeDemoSchedulers,
  scheduleDemoReset,
} from '@/server/demo/reset'
import { resyncAll } from '@/server/engine/scheduler'
import { createRedis } from '@/server/redis'
import { QUEUE_NAMES } from '@/server/engine/names'
import { createWorker, type QueueFactoryOptions } from '@/server/engine/queues'
import {
  QUORUM_RECOMPUTE_INTERVAL_MS,
  QUORUM_RECOMPUTE_JOB_NAME,
  recomputeQuorumStatuses,
} from '@/server/jobs/quorum-recompute'
import { processRetentionJob, RETENTION_JOB_NAME } from '@/server/jobs/retention'
import {
  PROBE_HEALTH_INTERVAL_MS,
  PROBE_HEALTH_JOB_NAME,
  refreshLocationStatuses,
} from '@/server/probes/health'
import { syncMaintenance, syncMaintenanceById, type SyncOptions } from './occurrences'
import {
  closeMaintenanceQueue,
  getMaintenanceQueue,
  MAINTENANCE_WAKEUP_JOB_NAME,
  type MaintenanceWakeupData,
} from './queue'
import { emitOrgMaintenanceList } from './realtime'
import { relationId } from './serialize'

export { closeMaintenanceQueue, getMaintenanceQueue }

const log = childLogger('maintenance:job')

export const MAINTENANCE_STATUS_JOB_NAME = 'maintenance-status'
export const MAINTENANCE_STATUS_INTERVAL_MS = 60_000

export interface RefreshResult {
  checked: number
  changed: number
  /** Organizations whose list was (re)published. */
  organizations: string[]
}

export interface RefreshOptions {
  /** Publish `maintenanceList` for organizations with changes (default true). */
  emit?: boolean
  /** Wake-up scheduling (see `SyncOptions.scheduleJobs`); the worker passes `'all'` on boot. */
  scheduleJobs?: SyncOptions['scheduleJobs']
}

/**
 * Sync every maintenance at `now` (injectable for tests): plan and advance occurrences, send due
 * reminders, persist effective statuses. `changed` counts maintenances whose status changed.
 */
export async function refreshMaintenanceStatuses(
  payload: Payload,
  now: Date = new Date(),
  options: RefreshOptions = {},
): Promise<RefreshResult> {
  const { docs } = await payload.find({
    collection: 'maintenance',
    depth: 0,
    limit: 0,
    pagination: false,
    overrideAccess: true,
  })

  const changedOrgs = new Set<string | number>()
  let changed = 0
  for (const doc of docs as Maintenance[]) {
    try {
      const result = await syncMaintenance(payload, doc, {
        now,
        scheduleJobs: options.scheduleJobs ?? 'changed',
      })
      if (result.statusChanged) changed += 1
      if (result.statusChanged || result.occurrencesChanged) {
        const orgId = relationId(doc.organization)
        if (orgId !== null) changedOrgs.add(orgId)
      }
    } catch (err) {
      log.error({ err, maintenanceId: doc.id }, 'failed to refresh maintenance status')
    }
  }

  if (options.emit !== false) {
    for (const orgId of changedOrgs) await emitOrgMaintenanceList(payload, orgId)
  }
  return { checked: docs.length, changed, organizations: [...changedOrgs].map(String) }
}

/**
 * A delayed wake-up: sync the maintenance at the planned instant (never earlier, so a worker
 * clock slightly behind the planner's still applies the transition) and publish on change.
 */
export async function processMaintenanceWakeup(
  payload: Payload,
  data: MaintenanceWakeupData,
  options: { emit?: boolean } = {},
): Promise<{ status: string } | null> {
  const now = new Date(Math.max(Date.now(), Number(data.at) || 0))
  const result = await syncMaintenanceById(payload, data.maintenanceId, { now })
  if (!result) return null
  if (options.emit !== false && (result.statusChanged || result.occurrencesChanged)) {
    const doc = await payload.findByID({
      collection: 'maintenance',
      id: data.maintenanceId,
      depth: 0,
      overrideAccess: true,
      disableErrors: true,
      select: { organization: true },
    })
    const orgId = relationId(doc?.organization)
    if (orgId !== null) await emitOrgMaintenanceList(payload, orgId)
  }
  return { status: result.status }
}

/** Upsert the every-minute `maintenance-status` scheduler. Idempotent; call on every worker boot. */
export async function scheduleMaintenanceStatusJob(queue: Queue): Promise<void> {
  await queue.upsertJobScheduler(
    MAINTENANCE_STATUS_JOB_NAME,
    { every: MAINTENANCE_STATUS_INTERVAL_MS },
    {
      name: MAINTENANCE_STATUS_JOB_NAME,
      opts: { removeOnComplete: 10, removeOnFail: 50 },
    },
  )
  log.info(
    { queue: queue.name, everyMs: MAINTENANCE_STATUS_INTERVAL_MS },
    'maintenance status scheduler upserted',
  )
}

/** Redis connection of the demo reset lock (created on the first reset). */
let demoLockClient: ReturnType<typeof createRedis> | undefined

/** Processor of the maintenance queue: reconciler, wake-ups and retention jobs. */
export const processMaintenanceJob =
  (payload: Payload) =>
  async (job: Job): Promise<unknown> => {
    if (job.name === MAINTENANCE_STATUS_JOB_NAME) return refreshMaintenanceStatuses(payload)
    if (job.name === MAINTENANCE_WAKEUP_JOB_NAME) {
      return processMaintenanceWakeup(payload, job.data as MaintenanceWakeupData)
    }
    if (job.name === RETENTION_JOB_NAME) return processRetentionJob(payload)(job)
    if (job.name === PROBE_HEALTH_JOB_NAME) return refreshLocationStatuses(payload)
    if (job.name === QUORUM_RECOMPUTE_JOB_NAME) return recomputeQuorumStatuses(payload)
    if (job.name === DEMO_RESET_JOB_NAME) {
      demoLockClient ??= createRedis()
      return processDemoResetJob(payload, job, {
        resync: (p) => resyncAll(p),
        withLock: redisLock(demoLockClient),
      })
    }
    if (job.name === DEMO_PROBES_JOB_NAME) return runDemoProbes(payload)
    log.warn({ jobId: job.id, name: job.name }, 'unknown job on the maintenance queue; ignored')
    return undefined
  }

/** Upsert the every-15-seconds `probe-health` scheduler (#91). Idempotent. */
export async function scheduleProbeHealthJob(queue: Queue): Promise<void> {
  await queue.upsertJobScheduler(
    PROBE_HEALTH_JOB_NAME,
    { every: PROBE_HEALTH_INTERVAL_MS },
    { name: PROBE_HEALTH_JOB_NAME, opts: { removeOnComplete: 10, removeOnFail: 50 } },
  )
}

/** Upsert the every-minute `quorum-recompute` scheduler (#92). Idempotent. */
export async function scheduleQuorumRecomputeJob(queue: Queue): Promise<void> {
  await queue.upsertJobScheduler(
    QUORUM_RECOMPUTE_JOB_NAME,
    { every: QUORUM_RECOMPUTE_INTERVAL_MS },
    { name: QUORUM_RECOMPUTE_JOB_NAME, opts: { removeOnComplete: 10, removeOnFail: 50 } },
  )
}

/**
 * Demo mode (#159): upsert the reset and simulated-probe schedulers and enqueue the boot reset; on
 * any other instance remove them, so a former demo's scheduler can never wipe real data.
 */
export async function scheduleDemoJobs(queue: Queue): Promise<void> {
  if (!isDemoMode()) {
    await removeDemoSchedulers(queue)
    await queue.removeJobScheduler(DEMO_PROBES_JOB_NAME)
    return
  }
  await scheduleDemoReset(queue)
  await queue.upsertJobScheduler(
    DEMO_PROBES_JOB_NAME,
    { every: DEMO_PROBES_INTERVAL_MS },
    { name: DEMO_PROBES_JOB_NAME, opts: { removeOnComplete: 10, removeOnFail: 50 } },
  )
  await enqueueBootReset(queue)
}

/**
 * Worker entrypoint helper: upsert the scheduler and start the worker on the maintenance queue.
 * Returns the worker so the caller can `close()` it on shutdown.
 */
export async function startMaintenanceWorker(
  payload: Payload,
  options: QueueFactoryOptions = {},
): Promise<Worker> {
  await scheduleMaintenanceStatusJob(getMaintenanceQueue(options))
  await scheduleProbeHealthJob(getMaintenanceQueue(options))
  await scheduleQuorumRecomputeJob(getMaintenanceQueue(options))
  await scheduleDemoJobs(getMaintenanceQueue(options))
  // Re-plan every wake-up once per boot (they may have been lost with Redis).
  try {
    await refreshMaintenanceStatuses(payload, new Date(), { scheduleJobs: 'all' })
  } catch (err) {
    log.error({ err }, 'initial maintenance sync failed')
  }
  const worker = createWorker(QUEUE_NAMES.maintenance, processMaintenanceJob(payload), {
    ...options,
    concurrency: 1,
  })
  worker.on('failed', (job, err) => {
    log.error({ err, jobId: job?.id, name: job?.name }, 'maintenance job failed')
  })
  worker.on('error', (err) => {
    log.error({ err }, 'maintenance worker error')
  })
  worker.on('ready', () => {
    log.info({ queue: QUEUE_NAMES.maintenance }, 'maintenance worker ready')
  })
  return worker
}
