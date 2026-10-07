import type { Job, Worker } from 'bullmq'
import type { Payload } from 'payload'

import { env } from '@/env'
import { childLogger } from '@/lib/logger'
import {
  ADHOC_CHECK_JOB_NAME,
  MANUAL_CHECK_JOB_NAME,
  QUEUE_NAMES,
  type CheckJobName,
} from './names'
import { processAdhocCheckJob, processManualCheckJob } from './on-demand-jobs'
import {
  createWorker,
  type AdhocCheckJobData,
  type CheckJobData,
  type ChecksQueueJobData,
  type ChecksQueueResult,
  type ManualCheckJobData,
  type QueueFactoryOptions,
} from './queues'
import { processCheckJob } from './worker'

const log = childLogger('engine:worker')

export interface StartCheckWorkerOptions extends QueueFactoryOptions {
  concurrency?: number
}

/**
 * Processor of the checks queue: scheduled `check` jobs, and the on-demand `manual-check` /
 * `adhoc-check` jobs whose result goes back to the waiting request as the job's return value.
 */
export async function processChecksQueueJob(
  payload: Payload,
  job: Job<ChecksQueueJobData, ChecksQueueResult, CheckJobName>,
): Promise<ChecksQueueResult> {
  switch (job.name) {
    case MANUAL_CHECK_JOB_NAME:
      return processManualCheckJob(payload, job.data as ManualCheckJobData)
    case ADHOC_CHECK_JOB_NAME:
      return processAdhocCheckJob(payload, job.data as AdhocCheckJobData)
    default:
      await processCheckJob(payload, job as unknown as Job<CheckJobData>)
  }
}

/** Start the BullMQ worker consuming the checks queue. */
export function startCheckWorker(
  payload: Payload,
  options: StartCheckWorkerOptions = {},
): Worker<ChecksQueueJobData, ChecksQueueResult, CheckJobName> {
  const concurrency = options.concurrency ?? env.WORKER_CONCURRENCY
  const worker = createWorker<ChecksQueueJobData, ChecksQueueResult, CheckJobName>(
    QUEUE_NAMES.checks,
    (job) => processChecksQueueJob(payload, job),
    { connection: options.connection, prefix: options.prefix, concurrency },
  )

  worker.on('failed', (job, err) => {
    // On-demand jobs the worker declined (expired, paused monitor…) are not errors.
    if (err?.name === 'OnDemandSkipError') return
    const monitorId = job?.data && 'monitorId' in job.data ? job.data.monitorId : undefined
    log.error({ err, jobId: job?.id, jobName: job?.name, monitorId }, 'check job failed')
  })
  worker.on('error', (err) => {
    log.error({ err }, 'check worker error')
  })
  worker.on('ready', () => {
    log.info({ queue: QUEUE_NAMES.checks, concurrency }, 'check worker ready')
  })

  return worker
}
