/**
 * Webhook delivery jobs on the notifications queue (`marmot:notifications`), processed by the same
 * worker as monitor alerts and subscriber messages:
 *
 *   `webhook-delivery` `{ deliveryId }` — one POST of one logged delivery (`./deliver.ts`).
 *
 * Retries: twelve attempts with exponential backoff from 40 s (40 s, 80 s, 160 s, … ≈ 23 h in
 * total, ±20 % jitter), so a receiver that is down for most of a day still gets its events.
 * The job id (`whd-<delivery id>`) makes enqueueing idempotent. Tests replace the sink with
 * `setWebhookJobSink` to run jobs inline.
 */
import type { JobsOptions, Queue } from 'bullmq'

import { env } from '@/env'
import { childLogger } from '@/lib/logger'
import { getNotificationsQueue } from '@/server/notifications/dispatch'

const log = childLogger('webhooks:queue')

export const WEBHOOK_DELIVERY_JOB = 'webhook-delivery' as const

export interface WebhookDeliveryJobData {
  deliveryId: string
}

export const isWebhookJobName = (name: string): name is typeof WEBHOOK_DELIVERY_JOB =>
  name === WEBHOOK_DELIVERY_JOB

export const WEBHOOK_DELIVERY_ATTEMPTS = 12
export const WEBHOOK_RETRY_BASE_DELAY_MS = 40_000

export const WEBHOOK_JOB_OPTIONS: JobsOptions = {
  attempts: WEBHOOK_DELIVERY_ATTEMPTS,
  backoff: { type: 'exponential', delay: WEBHOOK_RETRY_BASE_DELAY_MS, jitter: 0.2 },
  removeOnComplete: { age: 24 * 3600, count: 10_000 },
  removeOnFail: { age: 7 * 24 * 3600 },
}

export const webhookJobId = (deliveryId: string | number) => `whd-${deliveryId}`

export interface WebhookJob {
  name: typeof WEBHOOK_DELIVERY_JOB
  data: WebhookDeliveryJobData
  opts: JobsOptions & { jobId: string }
}

export const webhookDeliveryJob = (deliveryId: string | number): WebhookJob => ({
  name: WEBHOOK_DELIVERY_JOB,
  data: { deliveryId: String(deliveryId) },
  opts: { ...WEBHOOK_JOB_OPTIONS, jobId: webhookJobId(deliveryId) },
})

/** Where jobs go: BullMQ by default, an inline runner in tests. */
export type WebhookJobSink = (jobs: WebhookJob[]) => Promise<void>

let sink: WebhookJobSink | null = null

/** Replace the job sink (tests); `null` restores BullMQ. */
export function setWebhookJobSink(next: WebhookJobSink | null): void {
  sink = next
}

/**
 * Hands jobs to the sink. Without an explicit sink and with `MARMOT_DISABLE_ENGINE_HOOKS`
 * (integration tests without a worker) nothing is enqueued and the deliveries stay `pending`.
 */
export async function enqueueWebhookJobs(jobs: WebhookJob[]): Promise<void> {
  if (jobs.length === 0) return
  if (sink) return sink(jobs)
  if (env.MARMOT_DISABLE_ENGINE_HOOKS) {
    log.debug({ jobs: jobs.length }, 'engine hooks disabled; webhook jobs not enqueued')
    return
  }
  const queue = getNotificationsQueue() as unknown as Queue<
    WebhookDeliveryJobData,
    void,
    typeof WEBHOOK_DELIVERY_JOB
  >
  await queue.addBulk(jobs)
}
