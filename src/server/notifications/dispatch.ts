import type { JobsOptions, Queue } from 'bullmq'
import type { Payload } from 'payload'

import { childLogger } from '@/lib/logger'
import type { Monitor, Notification } from '@/payload-types'
import type { NotificationEvent } from '@/server/engine/beat'
import type { HeartbeatEvent } from '@/server/engine/hooks'
import { QUEUE_NAMES } from '@/server/engine/names'
import { createQueue, type QueueFactoryOptions } from '@/server/engine/queues'

const log = childLogger('notifications:dispatch')

/** Job name on the notifications queue. */
export const NOTIFICATION_JOB_NAME = 'notify' as const

export interface NotificationJobData {
  notificationId: string
  monitorId: string
  heartbeatId: string
  organizationId: string | null
  /** Why the channel is notified (absent on jobs enqueued before the field existed). */
  notificationEvent?: NotificationEvent | null
}

/**
 * Events every channel receives: the behaviour from before the degraded state. `degraded` is
 * opt-in; until per-channel event filters land (#126) no channel opts in, so degraded transitions
 * are recorded and shown everywhere but not sent.
 */
export const DEFAULT_NOTIFICATION_EVENTS: readonly NotificationEvent[] = ['down', 'up', 'reminder']

/**
 * Does `channel` want notifications for `event`? The single filter point of the dispatcher: #126
 * replaces the default set with the channel's own selection. A beat without an event (callers from
 * before the field existed) goes to every channel, as before.
 */
export function channelAcceptsEvent(
  _channel: Pick<Notification, 'id'>,
  event: NotificationEvent | null | undefined,
): boolean {
  if (!event) return true
  return DEFAULT_NOTIFICATION_EVENTS.includes(event)
}

export type NotificationsQueue = Queue<NotificationJobData, void, typeof NOTIFICATION_JOB_NAME>

/**
 * One job per (channel, heartbeat): BullMQ rejects a second job with the same id while the first
 * still exists, which is what dedupes a heartbeat that is emitted twice.
 */
export const notificationJobId = (
  notificationId: string | number,
  heartbeatId: string | number,
): string => `notif:${notificationId}:${heartbeatId}`

/** Three attempts with exponential backoff (5s, 10s, 20s), as in Kuma's retry-less providers plus a cushion. */
export const NOTIFICATION_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 5_000 },
  removeOnComplete: { age: 24 * 3600, count: 5_000 },
  removeOnFail: { age: 7 * 24 * 3600 },
}

let notificationsQueue: NotificationsQueue | undefined

/** Process-wide notifications queue (lazy; shares one Redis connection). */
export function getNotificationsQueue(): NotificationsQueue {
  notificationsQueue ??= createQueue<NotificationJobData, void, typeof NOTIFICATION_JOB_NAME>(
    QUEUE_NAMES.notifications,
  )
  return notificationsQueue
}

/** Close the shared queue (and its connection). Safe to call when nothing was opened. */
export async function closeNotificationsQueue(): Promise<void> {
  const queue = notificationsQueue
  notificationsQueue = undefined
  if (queue) await queue.close()
}

const relationIds = (value: Monitor['notifications']): (string | number)[] =>
  (value ?? []).map((item) =>
    typeof item === 'object' && item !== null ? (item as Notification).id : item,
  )

/**
 * Active channels attached to a monitor, in the monitor's organization. Channels that were
 * deleted or deactivated since they were attached are skipped.
 */
export async function getMonitorNotifications(
  payload: Payload,
  monitor: Monitor,
): Promise<Notification[]> {
  const ids = relationIds(monitor.notifications)
  if (ids.length === 0) return []
  const { docs } = await payload.find({
    collection: 'notifications',
    where: { and: [{ id: { in: ids } }, { active: { equals: true } }] },
    depth: 0,
    limit: ids.length,
    pagination: false,
    overrideAccess: true,
  })
  return docs as Notification[]
}

export interface EnqueueOptions extends QueueFactoryOptions {
  queue?: NotificationsQueue
}

export interface EnqueueResult {
  /** Channels considered (active + attached + accepting the beat's event). */
  channels: number
  /** Jobs that were actually new (not deduped). */
  enqueued: number
}

/**
 * Enqueue one notification job per active channel attached to the monitor of a heartbeat event.
 * Called by the heartbeat listener when `event.notify` is true; safe to call twice for the same
 * heartbeat (the job id dedupes).
 */
export async function enqueueNotificationsForHeartbeat(
  event: Pick<HeartbeatEvent, 'payload' | 'monitor' | 'heartbeat' | 'organizationId'> &
    Partial<Pick<HeartbeatEvent, 'notificationEvent'>>,
  options: EnqueueOptions = {},
): Promise<EnqueueResult> {
  const { payload, monitor, heartbeat } = event
  const notificationEvent = event.notificationEvent ?? null
  const channels = (await getMonitorNotifications(payload, monitor)).filter((channel) =>
    channelAcceptsEvent(channel, notificationEvent),
  )
  if (channels.length === 0) return { channels: 0, enqueued: 0 }

  const queue = options.queue ?? getNotificationsQueue()
  const organizationId =
    event.organizationId !== undefined && event.organizationId !== null
      ? String(event.organizationId)
      : null

  // BullMQ silently keeps the existing job when the id is taken, so look the ids up first to
  // report (and log) how many were really new. The add itself stays idempotent either way.
  const existing = await Promise.all(
    channels.map((channel) => queue.getJob(notificationJobId(channel.id, heartbeat.id))),
  )
  const fresh = channels.filter((_, index) => !existing[index])

  if (fresh.length > 0) {
    await queue.addBulk(
      fresh.map((channel) => ({
        name: NOTIFICATION_JOB_NAME,
        data: {
          notificationId: String(channel.id),
          monitorId: String(monitor.id),
          heartbeatId: String(heartbeat.id),
          organizationId,
          ...(notificationEvent ? { notificationEvent } : {}),
        },
        opts: { ...NOTIFICATION_JOB_OPTIONS, jobId: notificationJobId(channel.id, heartbeat.id) },
      })),
    )
  }
  const enqueued = fresh.length

  log.debug(
    {
      monitorId: monitor.id,
      heartbeatId: heartbeat.id,
      notificationEvent,
      channels: channels.length,
      enqueued,
    },
    'notification jobs enqueued',
  )
  return { channels: channels.length, enqueued }
}
