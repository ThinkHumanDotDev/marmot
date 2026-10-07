import { UnrecoverableError, type Job, type Worker } from 'bullmq'
import type { Payload } from 'payload'

import { env } from '@/env'
import { childLogger } from '@/lib/logger'
import type { Heartbeat, Monitor, Notification } from '@/payload-types'
import { QUEUE_NAMES } from '@/server/engine/names'
import { createWorker, type QueueFactoryOptions } from '@/server/engine/queues'
import type { NotificationJobData } from './dispatch'
import { buildDefaultMessage } from './message'
import { getChannelLocale, sendNotification } from './send'
import { ServerSmtpSendError } from './server-smtp'
import {
  isSubscriberJobName,
  type SubscriberJobData,
} from '@/server/status-pages/subscribers/queue'
import { processSubscriberJob } from '@/server/status-pages/subscribers/worker'
import { processWebhookDeliveryJob } from '@/server/webhooks/deliver'
import { isWebhookJobName, type WebhookDeliveryJobData } from '@/server/webhooks/queue'

const log = childLogger('notifications:worker')

/** Minimal job shape the processor needs, so tests can pass a plain object. */
export type NotificationJobLike = Pick<Job<NotificationJobData>, 'data'> &
  Partial<Pick<Job, 'id' | 'attemptsMade'>>

export interface ProcessNotificationResult {
  outcome: 'sent' | 'skipped'
  reason?: string
  result?: string
}

const findOrNull = async <T>(fn: () => Promise<T>): Promise<T | null> => {
  try {
    return await fn()
  } catch {
    return null
  }
}

/** Record the delivery outcome on the channel without re-triggering its hooks. */
async function recordOutcome(
  payload: Payload,
  notification: Notification,
  outcome: { ok: true } | { ok: false; error: string },
): Promise<void> {
  try {
    await payload.update({
      collection: 'notifications',
      id: notification.id,
      depth: 0,
      overrideAccess: true,
      context: { skipNotificationHooks: true },
      data: outcome.ok
        ? { lastSentAt: new Date().toISOString(), lastError: null }
        : { lastError: outcome.error.slice(0, 1000) },
    })
  } catch (err) {
    log.warn({ err, notificationId: notification.id }, 'failed to record notification outcome')
  }
}

/**
 * Job processor: load channel + monitor + heartbeat, render the message, call the provider and
 * store the outcome on the channel. Throws on delivery failure so BullMQ retries, except for
 * deliveries refused by the server-SMTP rules (retrying would only repeat the refusal). Exported so
 * tests can call it with a fake job.
 */
export async function processNotificationJob(
  payload: Payload,
  job: NotificationJobLike,
): Promise<ProcessNotificationResult> {
  const { notificationId, monitorId, heartbeatId } = job.data

  const notification = (await findOrNull(() =>
    payload.findByID({
      collection: 'notifications',
      id: notificationId,
      depth: 0,
      overrideAccess: true,
    }),
  )) as Notification | null
  if (!notification) return { outcome: 'skipped', reason: 'notification-not-found' }
  if (!notification.active) return { outcome: 'skipped', reason: 'inactive' }

  const monitor = (await findOrNull(() =>
    payload.findByID({ collection: 'monitors', id: monitorId, depth: 0, overrideAccess: true }),
  )) as Monitor | null
  if (!monitor) return { outcome: 'skipped', reason: 'monitor-not-found' }

  const heartbeat = (await findOrNull(() =>
    payload.findByID({ collection: 'heartbeats', id: heartbeatId, depth: 0, overrideAccess: true }),
  )) as Heartbeat | null
  if (!heartbeat) return { outcome: 'skipped', reason: 'heartbeat-not-found' }

  const locale = await getChannelLocale(payload, notification)
  const message = buildDefaultMessage(monitor, heartbeat, locale)
  try {
    const result = await sendNotification(payload, notification, {
      message,
      monitor,
      heartbeat,
      locale,
    })
    await recordOutcome(payload, notification, { ok: true })
    log.info(
      { notificationId, type: notification.type, monitorId, heartbeatId, status: heartbeat.status },
      'notification sent',
    )
    return { outcome: 'sent', result }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    await recordOutcome(payload, notification, { ok: false, error })
    log.error(
      { err, notificationId, type: notification.type, monitorId, attempt: job.attemptsMade },
      'notification failed',
    )
    if (err instanceof ServerSmtpSendError) throw new UnrecoverableError(error)
    throw err
  }
}

export interface StartNotificationWorkerOptions extends QueueFactoryOptions {
  concurrency?: number
}

/**
 * Start the BullMQ worker consuming the notifications queue: monitor alerts (`notify`), status
 * page subscriber jobs (`subscriber-fanout`, `subscriber-delivery`) and outbound webhook deliveries
 * (`webhook-delivery`).
 */
export function startNotificationWorker(
  payload: Payload,
  options: StartNotificationWorkerOptions = {},
): Worker<NotificationJobData, void, string> {
  const concurrency = options.concurrency ?? env.WORKER_CONCURRENCY
  const worker = createWorker<NotificationJobData, void, string>(
    QUEUE_NAMES.notifications,
    async (job) => {
      // Subscriber jobs share the queue; their data has another shape.
      if (isSubscriberJobName(job.name)) {
        await processSubscriberJob(payload, job as unknown as Job<SubscriberJobData>)
        return
      }
      if (isWebhookJobName(job.name)) {
        await processWebhookDeliveryJob(payload, job as unknown as Job<WebhookDeliveryJobData>)
        return
      }
      await processNotificationJob(payload, job)
    },
    { connection: options.connection, prefix: options.prefix, concurrency },
  )

  worker.on('failed', (job, err) => {
    log.error(
      { err, jobId: job?.id, name: job?.name, attempt: job?.attemptsMade },
      'notification job failed',
    )
  })
  worker.on('error', (err) => {
    log.error({ err }, 'notification worker error')
  })
  worker.on('ready', () => {
    log.info({ queue: QUEUE_NAMES.notifications, concurrency }, 'notification worker ready')
  })

  return worker
}
