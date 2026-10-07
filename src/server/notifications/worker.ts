import { UnrecoverableError, type Job, type Worker } from 'bullmq'
import type { Payload } from 'payload'

import { env } from '@/env'
import { childLogger } from '@/lib/logger'
import type { Heartbeat, Monitor, Notification } from '@/payload-types'
import { QUEUE_NAMES } from '@/server/engine/names'
import { createWorker, type QueueFactoryOptions } from '@/server/engine/queues'
import { channelAcceptsEvent, type NotificationJobData } from './dispatch'
import { recoveryDowntimeSeconds } from './downtime'
import {
  buildMaintenanceMessage,
  MAINTENANCE_NOTIFICATION_JOB_NAME,
  docIdFromString,
  type MaintenanceNotificationJobData,
} from './maintenance'
import { buildDefaultMessage } from './message'
import { getChannelOrganization, sendNotification } from './send'
import { ServerSmtpSendError } from './server-smtp'
import {
  isSubscriberJobName,
  type SubscriberJobData,
} from '@/server/status-pages/subscribers/queue'
import { processSubscriberJob } from '@/server/status-pages/subscribers/worker'

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
  const event = job.data.notificationEvent ?? null

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
  // The selection may have changed since the job was enqueued (retries, a busy queue).
  if (!channelAcceptsEvent(notification, event)) {
    return { outcome: 'skipped', reason: 'event-filtered' }
  }

  const monitor = (await findOrNull(() =>
    payload.findByID({ collection: 'monitors', id: monitorId, depth: 0, overrideAccess: true }),
  )) as Monitor | null
  if (!monitor) return { outcome: 'skipped', reason: 'monitor-not-found' }

  const heartbeat = (await findOrNull(() =>
    payload.findByID({ collection: 'heartbeats', id: heartbeatId, depth: 0, overrideAccess: true }),
  )) as Heartbeat | null
  if (!heartbeat) return { outcome: 'skipped', reason: 'heartbeat-not-found' }

  const channelOrganization = await getChannelOrganization(payload, notification)
  const { locale } = channelOrganization
  const downtimeSeconds =
    event === 'up' ? await findOrNull(() => recoveryDowntimeSeconds(payload, heartbeat)) : null
  const message = buildDefaultMessage(monitor, heartbeat, locale, { event, downtimeSeconds })
  try {
    const result = await sendNotification(payload, notification, {
      message,
      monitor,
      heartbeat,
      event,
      downtimeSeconds,
      locale,
      channelOrganization,
    })
    await recordOutcome(payload, notification, { ok: true })
    log.info(
      {
        notificationId,
        type: notification.type,
        monitorId,
        heartbeatId,
        status: heartbeat.status,
        event,
      },
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

/**
 * Job processor for `notify-maintenance` (a maintenance window started or ended): one message to
 * one channel, listing the window's monitors that use the channel. Same retry and outcome rules
 * as `processNotificationJob`.
 */
export async function processMaintenanceNotificationJob(
  payload: Payload,
  job: Pick<Job<MaintenanceNotificationJobData>, 'data'> &
    Partial<Pick<Job, 'id' | 'attemptsMade'>>,
): Promise<ProcessNotificationResult> {
  const { notificationId, monitorIds, type, title } = job.data
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
  if (!channelAcceptsEvent(notification, 'maintenance')) {
    return { outcome: 'skipped', reason: 'event-filtered' }
  }

  const { docs } = await payload.find({
    collection: 'monitors',
    where: { id: { in: monitorIds.map((id) => docIdFromString(payload, id)) } },
    depth: 0,
    limit: 0,
    pagination: false,
    overrideAccess: true,
    select: { name: true },
  })
  const names = (docs as Pick<Monitor, 'id' | 'name'>[]).map((doc) => doc.name)
  if (names.length === 0) return { outcome: 'skipped', reason: 'monitor-not-found' }

  const channelOrganization = await getChannelOrganization(payload, notification)
  const { locale } = channelOrganization
  const collator = new Intl.Collator(locale)
  const message = buildMaintenanceMessage(type, title, names.sort(collator.compare), locale)
  try {
    const result = await sendNotification(payload, notification, {
      message,
      monitor: null,
      heartbeat: null,
      event: 'maintenance',
      locale,
      channelOrganization,
    })
    await recordOutcome(payload, notification, { ok: true })
    log.info({ notificationId, type: notification.type, maintenance: type }, 'notification sent')
    return { outcome: 'sent', result }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    await recordOutcome(payload, notification, { ok: false, error })
    log.error(
      { err, notificationId, type: notification.type, attempt: job.attemptsMade },
      'maintenance notification failed',
    )
    if (err instanceof ServerSmtpSendError) throw new UnrecoverableError(error)
    throw err
  }
}

export interface StartNotificationWorkerOptions extends QueueFactoryOptions {
  concurrency?: number
}

/**
 * Start the BullMQ worker consuming the notifications queue: monitor alerts (`notify`), maintenance
 * windows (`notify-maintenance`) and status page subscriber jobs (`subscriber-fanout`, `subscriber-delivery`).
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
      if (job.name === MAINTENANCE_NOTIFICATION_JOB_NAME) {
        await processMaintenanceNotificationJob(
          payload,
          job as unknown as Job<MaintenanceNotificationJobData>,
        )
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
