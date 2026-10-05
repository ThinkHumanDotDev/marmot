/**
 * Maintenance status job: once a minute the worker recomputes every maintenance's status,
 * persists the ones that changed (`maintenance.status`) and publishes the organization's list to
 * its socket room, so dashboards flip to "Under maintenance" without a page load.
 *
 * Runs as the `maintenance-status` BullMQ job scheduler on the `marmot:maintenance` queue; the
 * worker started here also executes `retention` jobs (`src/server/jobs/retention.ts`) so a single
 * worker serves that queue.
 */
import type { Job, Queue, Worker } from 'bullmq'
import type { Payload } from 'payload'

import { childLogger } from '@/lib/logger'
import type { Maintenance } from '@/payload-types'
import { QUEUE_NAMES } from '@/server/engine/names'
import { createQueue, createWorker, type QueueFactoryOptions } from '@/server/engine/queues'
import { processRetentionJob, RETENTION_JOB_NAME } from '@/server/jobs/retention'
import { emitOrgMaintenanceList } from './realtime'
import { relationId, timeslotsFor } from './serialize'

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
}

/**
 * Recompute and persist statuses. `now` is injectable for tests. Writes use
 * `context.skipMaintenanceHooks` so the collection hooks neither recompute nor re-emit.
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
      const { status } = await timeslotsFor(payload, doc, now)
      if (status === doc.status) continue
      await payload.update({
        collection: 'maintenance',
        id: doc.id,
        data: { status },
        depth: 0,
        overrideAccess: true,
        context: { skipMaintenanceHooks: true },
      })
      changed += 1
      const orgId = relationId(doc.organization)
      if (orgId !== null) changedOrgs.add(orgId)
      log.info({ maintenanceId: doc.id, from: doc.status, to: status }, 'maintenance status changed')
    } catch (err) {
      log.error({ err, maintenanceId: doc.id }, 'failed to refresh maintenance status')
    }
  }

  if (options.emit !== false) {
    for (const orgId of changedOrgs) await emitOrgMaintenanceList(payload, orgId)
  }
  return { checked: docs.length, changed, organizations: [...changedOrgs].map(String) }
}

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

/** Processor of the maintenance queue: status refreshes, plus retention jobs when scheduled. */
export const processMaintenanceJob =
  (payload: Payload) =>
  async (job: Job): Promise<unknown> => {
    if (job.name === MAINTENANCE_STATUS_JOB_NAME) return refreshMaintenanceStatuses(payload)
    if (job.name === RETENTION_JOB_NAME) return processRetentionJob(payload)(job)
    log.warn({ jobId: job.id, name: job.name }, 'unknown job on the maintenance queue; ignored')
    return undefined
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
