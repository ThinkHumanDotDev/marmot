/**
 * Processors of the subscriber jobs (see `./queue.ts`), run by the notifications worker
 * (`src/server/notifications/worker.ts` routes them by job name). Exported for tests, which call
 * them with plain job objects.
 */
import { UnrecoverableError, type Job } from 'bullmq'
import type { Payload } from 'payload'

import { childLogger } from '@/lib/logger'
import { isDiscordWebhookUrl, subscriberWantsComponents } from '@/lib/status-page-subscribers'
import type {
  StatusPageSubscriber,
  SubscriberDelivery,
  SubscriberNotification,
} from '@/payload-types'
import { renderAnnouncementEmail } from '@/server/email/subscriber-emails'

import {
  completeBatchIfDone,
  confirmedSubscribers,
  loadPageContext,
  subscriberLocale,
  type PageContext,
} from './batches'
import { discordMessage, renderSms, slackMessage, toAnnouncement, webhookBody } from './content'
import {
  DeliveryError,
  postSubscriberWebhook,
  sendSubscriberEmail,
  sendSubscriberSms,
} from './deliver'
import { subscriptionLinks } from './links'
import {
  DELIVERY_ATTEMPTS,
  SUBSCRIBER_DELIVERY_JOB,
  SUBSCRIBER_FANOUT_JOB,
  deliveryJob,
  enqueueSubscriberJobs,
  type SubscriberDeliveryJobData,
  type SubscriberFanoutJobData,
  type SubscriberJobData,
} from './queue'

const log = childLogger('status-pages:subscribers:worker')

export type SubscriberJobLike = Pick<Job<SubscriberJobData>, 'name' | 'data'> &
  Partial<Pick<Job, 'id' | 'attemptsMade' | 'opts'>>

export interface SubscriberJobResult {
  outcome: 'done' | 'sent' | 'skipped' | 'failed'
  reason?: string
  deliveries?: number
}

const relId = (value: unknown): string | number | null => {
  if (typeof value === 'string' || typeof value === 'number') return value
  if (value && typeof value === 'object' && 'id' in value) {
    const id = (value as { id: unknown }).id
    if (typeof id === 'string' || typeof id === 'number') return id
  }
  return null
}

const findOrNull = async <T>(fn: () => Promise<T>): Promise<T | null> => {
  try {
    return (await fn()) ?? null
  } catch {
    return null
  }
}

export async function processSubscriberJob(
  payload: Payload,
  job: SubscriberJobLike,
): Promise<SubscriberJobResult> {
  if (job.name === SUBSCRIBER_FANOUT_JOB) {
    return processFanout(payload, job.data as SubscriberFanoutJobData)
  }
  if (job.name === SUBSCRIBER_DELIVERY_JOB) {
    return processDelivery(payload, job.data as SubscriberDeliveryJobData, job)
  }
  return { outcome: 'skipped', reason: 'unknown-job' }
}

const isUniqueViolation = (err: unknown): boolean =>
  /unique|duplicate key|E11000|invalid/i.test(err instanceof Error ? err.message : String(err))

/**
 * Creates one `queued` delivery per confirmed subscriber the announcement concerns and enqueues
 * their jobs. Re-running it (a retried fan-out) finds the rows it already made and only re-enqueues
 * the ones still queued; BullMQ drops the duplicate job ids.
 */
async function processFanout(
  payload: Payload,
  { notificationId }: SubscriberFanoutJobData,
): Promise<SubscriberJobResult> {
  const notification = (await findOrNull(() =>
    payload.findByID({
      collection: 'subscriber-notifications',
      id: notificationId,
      depth: 0,
      overrideAccess: true,
    }),
  )) as SubscriberNotification | null
  if (!notification) return { outcome: 'skipped', reason: 'notification-not-found' }
  if (notification.state !== 'sending') return { outcome: 'skipped', reason: notification.state }

  const pageId = relId(notification.statusPage)
  const organization = relId(notification.organization)
  if (pageId === null || organization === null) {
    return { outcome: 'skipped', reason: 'page-not-found' }
  }

  const { docs: existingRows } = await payload.find({
    collection: 'subscriber-deliveries',
    where: { notification: { equals: notification.id } },
    depth: 0,
    limit: 0,
    pagination: false,
    overrideAccess: true,
    select: { subscriber: true, state: true },
  })
  const existing = new Map(existingRows.map((row) => [String(relId(row.subscriber)), row]))

  let total = existing.size
  const channels = new Set<string>()
  for await (const batch of confirmedSubscribers(payload, pageId)) {
    const jobs = []
    for (const subscriber of batch) {
      if (!subscriberWantsComponents(subscriber.components, notification.components)) continue
      channels.add(subscriber.channel)
      const row = existing.get(String(subscriber.id))
      if (row) {
        if (row.state === 'queued') jobs.push(deliveryJob(row.id))
        continue
      }
      try {
        const created = await payload.create({
          collection: 'subscriber-deliveries',
          data: {
            organization: organization as SubscriberDelivery['organization'],
            notification: notification.id,
            subscriber: subscriber.id,
            channel: subscriber.channel,
            state: 'queued',
            attempts: 0,
          },
          depth: 0,
          overrideAccess: true,
        })
        total += 1
        jobs.push(deliveryJob(created.id))
      } catch (err) {
        if (!isUniqueViolation(err)) throw err
      }
    }
    await enqueueSubscriberJobs(jobs)
  }

  await payload.update({
    collection: 'subscriber-notifications',
    id: notification.id,
    data: {
      recipientCount: total,
      channels: [...channels] as SubscriberNotification['channels'],
    },
    depth: 0,
    overrideAccess: true,
  })
  if (total === 0) await completeBatchIfDone(payload, notification.id)
  log.info({ notificationId, deliveries: total }, 'subscriber fan-out done')
  return { outcome: 'done', deliveries: total }
}

/** Renders and sends one delivery for its channel. */
async function send(
  payload: Payload,
  ctx: PageContext,
  notification: SubscriberNotification,
  subscriber: StatusPageSubscriber,
  delivery: SubscriberDelivery,
): Promise<void> {
  const announcement = toAnnouncement(notification, ctx.page, ctx.names)
  const locale = subscriberLocale(subscriber, ctx)
  const render = { locale, i18n: ctx.i18n }
  const links = subscriptionLinks(ctx.page, subscriber)
  const pageInfo = { title: ctx.page.title, url: announcement.url }

  switch (subscriber.channel) {
    case 'email':
      await sendSubscriberEmail(
        payload,
        subscriber.target,
        renderAnnouncementEmail(announcement, links, render),
        links,
      )
      return
    case 'sms':
      await sendSubscriberSms(
        payload,
        ctx.page,
        subscriber.target,
        renderSms(announcement, render, {
          templates: ctx.page.subscriptions?.smsTemplates,
          maxSegments: ctx.page.subscriptions?.smsMaxSegments,
        }),
      )
      return
    case 'slack':
      await postSubscriberWebhook({
        url: subscriber.target,
        body: slackMessage(announcement, links, render, pageInfo),
        event: announcement.event,
        deliveryId: String(delivery.id),
      })
      return
    case 'webhook': {
      const discord = isDiscordWebhookUrl(subscriber.target)
      await postSubscriberWebhook({
        url: subscriber.target,
        body: discord
          ? discordMessage(announcement, links, render, pageInfo)
          : webhookBody(announcement, links),
        secret: discord ? null : subscriber.secret,
        headers: subscriber.headers,
        event: announcement.event,
        deliveryId: String(delivery.id),
      })
      return
    }
  }
}

async function processDelivery(
  payload: Payload,
  { deliveryId }: SubscriberDeliveryJobData,
  job: SubscriberJobLike,
): Promise<SubscriberJobResult> {
  const delivery = (await findOrNull(() =>
    payload.findByID({
      collection: 'subscriber-deliveries',
      id: deliveryId,
      depth: 0,
      overrideAccess: true,
    }),
  )) as SubscriberDelivery | null
  if (!delivery) return { outcome: 'skipped', reason: 'delivery-not-found' }
  if (delivery.state === 'sent' || delivery.state === 'skipped') {
    return { outcome: 'skipped', reason: delivery.state }
  }
  const notificationId = relId(delivery.notification) as string | number

  const finish = async (
    data: Partial<Pick<SubscriberDelivery, 'state' | 'error' | 'sentAt' | 'attempts'>>,
  ) => {
    await payload.update({
      collection: 'subscriber-deliveries',
      id: delivery.id,
      data,
      depth: 0,
      overrideAccess: true,
    })
    if (data.state !== 'retrying') await completeBatchIfDone(payload, notificationId)
  }

  const notification = (await findOrNull(() =>
    payload.findByID({
      collection: 'subscriber-notifications',
      id: notificationId,
      depth: 0,
      overrideAccess: true,
    }),
  )) as SubscriberNotification | null
  if (!notification || notification.state === 'discarded') {
    await finish({ state: 'skipped', error: null })
    return { outcome: 'skipped', reason: 'notification-gone' }
  }
  const subscriber = (await findOrNull(() =>
    payload.findByID({
      collection: 'status-page-subscribers',
      id: relId(delivery.subscriber) as string | number,
      depth: 0,
      overrideAccess: true,
    }),
  )) as StatusPageSubscriber | null
  if (!subscriber || !subscriber.confirmedAt) {
    await finish({ state: 'skipped', error: null })
    return { outcome: 'skipped', reason: 'subscriber-gone' }
  }
  const ctx = await loadPageContext(payload, relId(notification.statusPage) as string | number)
  if (!ctx) {
    await finish({ state: 'skipped', error: null })
    return { outcome: 'skipped', reason: 'page-gone' }
  }

  const attempts = (delivery.attempts ?? 0) + 1
  try {
    await send(payload, ctx, notification, subscriber, delivery)
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    const retryable = err instanceof DeliveryError ? err.retryable : true
    const maxAttempts = job.opts?.attempts ?? DELIVERY_ATTEMPTS
    const last = !retryable || (job.attemptsMade ?? 0) + 1 >= maxAttempts

    if (err instanceof DeliveryError && err.reason === 'unsubscribed') {
      // The phone number replied STOP to the provider: end the subscription.
      await finish({ state: 'skipped', error: error.slice(0, 500), attempts })
      await payload.delete({
        collection: 'status-page-subscribers',
        id: subscriber.id,
        overrideAccess: true,
      })
      return { outcome: 'skipped', reason: 'unsubscribed' }
    }

    await finish({ state: last ? 'failed' : 'retrying', error: error.slice(0, 500), attempts })
    await payload
      .update({
        collection: 'status-page-subscribers',
        id: subscriber.id,
        data: { lastError: error.slice(0, 500) },
        depth: 0,
        overrideAccess: true,
      })
      .catch(() => undefined)
    log.warn(
      { deliveryId, channel: subscriber.channel, attempts, retryable, err: error },
      'subscriber delivery failed',
    )
    if (last) throw new UnrecoverableError(error)
    throw err
  }

  const now = new Date().toISOString()
  await finish({ state: 'sent', error: null, sentAt: now, attempts })
  await payload
    .update({
      collection: 'status-page-subscribers',
      id: subscriber.id,
      data: { lastDeliveredAt: now, lastError: null },
      depth: 0,
      overrideAccess: true,
    })
    .catch(() => undefined)
  return { outcome: 'sent' }
}
