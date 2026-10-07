/**
 * Subscriber jobs on the notifications queue (`marmot:notifications`), next to the monitor
 * alerts (`notify` jobs), processed by the same worker:
 *
 * - `subscriber-fanout` `{ notificationId }`: creates one delivery row per matching subscriber and
 *   enqueues their delivery jobs;
 * - `subscriber-delivery` `{ deliveryId }`: renders and sends one message; five attempts with
 *   jittered exponential backoff (10 s, 20 s, 40 s, …) for retryable failures.
 *
 * Job ids make both idempotent (`spn-<notification>-<round>`, `spd-<delivery>-<round>`); a retry
 * from the builder uses a new round. Tests replace the sink with `setSubscriberJobSink` to run jobs
 * inline.
 */
import type { JobsOptions, Queue } from 'bullmq'

import { env } from '@/env'
import { childLogger } from '@/lib/logger'
import { getNotificationsQueue } from '@/server/notifications/dispatch'

const log = childLogger('status-pages:subscribers:queue')

export const SUBSCRIBER_FANOUT_JOB = 'subscriber-fanout' as const
export const SUBSCRIBER_DELIVERY_JOB = 'subscriber-delivery' as const
export type SubscriberJobName = typeof SUBSCRIBER_FANOUT_JOB | typeof SUBSCRIBER_DELIVERY_JOB

export interface SubscriberFanoutJobData {
  notificationId: string
}
export interface SubscriberDeliveryJobData {
  deliveryId: string
}
export type SubscriberJobData = SubscriberFanoutJobData | SubscriberDeliveryJobData

export const isSubscriberJobName = (name: string): name is SubscriberJobName =>
  name === SUBSCRIBER_FANOUT_JOB || name === SUBSCRIBER_DELIVERY_JOB

export const DELIVERY_ATTEMPTS = 5

export const FANOUT_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 5_000 },
  removeOnComplete: { age: 24 * 3600, count: 1_000 },
  removeOnFail: { age: 7 * 24 * 3600 },
}

export const DELIVERY_JOB_OPTIONS: JobsOptions = {
  attempts: DELIVERY_ATTEMPTS,
  backoff: { type: 'exponential', delay: 10_000, jitter: 0.5 },
  removeOnComplete: { age: 24 * 3600, count: 10_000 },
  removeOnFail: { age: 7 * 24 * 3600 },
}

export const fanoutJobId = (notificationId: string | number, round: number | string = 0) =>
  `spn-${notificationId}-${round}`
export const deliveryJobId = (deliveryId: string | number, round: number | string = 0) =>
  `spd-${deliveryId}-${round}`

export interface SubscriberJob {
  name: SubscriberJobName
  data: SubscriberJobData
  opts: JobsOptions & { jobId: string }
}

/** Where jobs go: BullMQ by default, an inline runner in tests. */
export type SubscriberJobSink = (jobs: SubscriberJob[]) => Promise<void>

const bullSink: SubscriberJobSink = async (jobs) => {
  const queue = getNotificationsQueue() as unknown as Queue<
    SubscriberJobData,
    void,
    SubscriberJobName
  >
  await queue.addBulk(jobs)
}

let sink: SubscriberJobSink | null = null

/** Replace the job sink (tests); `null` restores the default. */
export function setSubscriberJobSink(next: SubscriberJobSink | null): void {
  sink = next
}

/**
 * Hands jobs to the sink. Without an explicit sink and with `MARMOT_DISABLE_ENGINE_HOOKS` (integration
 * tests without a worker) nothing is enqueued; batches then stay in `sending` until retried.
 */
export async function enqueueSubscriberJobs(jobs: SubscriberJob[]): Promise<void> {
  if (jobs.length === 0) return
  if (sink) return sink(jobs)
  if (env.MARMOT_DISABLE_ENGINE_HOOKS) {
    log.debug({ jobs: jobs.length }, 'engine hooks disabled; subscriber jobs not enqueued')
    return
  }
  await bullSink(jobs)
}

export const fanoutJob = (notificationId: string | number, round: number | string = 0) =>
  ({
    name: SUBSCRIBER_FANOUT_JOB,
    data: { notificationId: String(notificationId) },
    opts: { ...FANOUT_JOB_OPTIONS, jobId: fanoutJobId(notificationId, round) },
  }) satisfies SubscriberJob

export const deliveryJob = (deliveryId: string | number, round: number | string = 0) =>
  ({
    name: SUBSCRIBER_DELIVERY_JOB,
    data: { deliveryId: String(deliveryId) },
    opts: { ...DELIVERY_JOB_OPTIONS, jobId: deliveryJobId(deliveryId, round) },
  }) satisfies SubscriberJob
