/**
 * Subscriber notifications ("batches"): one announcement of an incident update or maintenance
 * event to every matching subscriber of a page.
 *
 *   event ─▶ createNotificationBatch ─▶ `pending_review` (page in `review` mode)
 *                                   └─▶ `sending` + fan-out job (page in `auto` mode)
 *   pending_review ─ send ─▶ sending ─ fan-out / deliveries ─▶ sent | partially_failed | failed
 *   pending_review ─ discard ─▶ discarded
 *   partially_failed | failed ─ retry ─▶ sending (failed deliveries only)
 */
import type { Payload } from 'payload'

import type { Locale } from '@/i18n/locales'
import { toLocale } from '@/i18n/translator'
import { childLogger } from '@/lib/logger'
import {
  subscriberWantsComponents,
  type NotificationBatchState,
  type NotificationEvent,
  type SubscriberChannel,
} from '@/lib/status-page-subscribers'
import type {
  StatusPage,
  StatusPageSubscriber,
  SubscriberDelivery,
  SubscriberNotification,
} from '@/payload-types'
import { renderAnnouncementEmail, type RenderedEmail } from '@/server/email/subscriber-emails'
import { getOrganizationI18n, type OrganizationI18n } from '@/server/i18n'

import { componentNames, renderSms, toAnnouncement, type Announcement } from './content'
import { loadSmsChannel } from './deliver'
import { subscriptionLinks } from './links'
import { deliveryJob, enqueueSubscriberJobs, fanoutJob } from './queue'

const log = childLogger('status-pages:subscribers')

type Id = string | number

const relId = (value: unknown): Id | null => {
  if (typeof value === 'string' || typeof value === 'number') return value
  if (value && typeof value === 'object' && 'id' in value) {
    const id = (value as { id: unknown }).id
    if (typeof id === 'string' || typeof id === 'number') return id
  }
  return null
}

export type RecipientCounts = Record<SubscriberChannel, number> & { total: number }

const emptyCounts = (): RecipientCounts => ({ email: 0, sms: 0, webhook: 0, slack: 0, total: 0 })

/** Confirmed subscribers of a page, in id order, `pageSize` at a time. */
export async function* confirmedSubscribers(
  payload: Payload,
  pageId: Id,
  pageSize = 500,
): AsyncGenerator<StatusPageSubscriber[]> {
  let page = 1
  for (;;) {
    const result = await payload.find({
      collection: 'status-page-subscribers',
      where: {
        and: [{ statusPage: { equals: pageId } }, { confirmedAt: { exists: true } }],
      },
      depth: 0,
      limit: pageSize,
      page,
      sort: 'createdAt',
      overrideAccess: true,
    })
    if (result.docs.length > 0) yield result.docs as StatusPageSubscriber[]
    if (!result.hasNextPage) return
    page += 1
  }
}

/** Confirmed subscribers an announcement about `components` reaches, per channel. */
export async function countRecipients(
  payload: Payload,
  pageId: Id,
  components: readonly string[] | null | undefined,
): Promise<RecipientCounts> {
  const counts = emptyCounts()
  for await (const batch of confirmedSubscribers(payload, pageId)) {
    for (const subscriber of batch) {
      if (!subscriberWantsComponents(subscriber.components, components)) continue
      counts[subscriber.channel] += 1
      counts.total += 1
    }
  }
  return counts
}

export interface BatchInput {
  page: StatusPage
  event: NotificationEvent
  dedupeKey: string
  title: string
  status: string | null
  message: string
  components: string[]
  occurredAt: string
  window?: { start?: string | null; end?: string | null; reminderMinutes?: number | null }
  incident?: Id | null
  incidentUpdateId?: string | null
  maintenance?: Id | null
  occurrence?: Id | null
}

/**
 * Records an announcement for the page's subscribers. Returns `null` when subscriptions are off,
 * the page is not published, nobody would receive it, or the event was already recorded (same
 * `dedupeKey`). In `auto` mode the batch goes straight to `sending`.
 */
export async function createNotificationBatch(
  payload: Payload,
  input: BatchInput,
): Promise<SubscriberNotification | null> {
  const { page } = input
  if (!page.published || !page.subscriptions?.enabled) return null

  const existing = await payload.count({
    collection: 'subscriber-notifications',
    where: { dedupeKey: { equals: input.dedupeKey } },
    overrideAccess: true,
  })
  if (existing.totalDocs > 0) return null

  const recipients = await countRecipients(payload, page.id, input.components)
  if (recipients.total === 0) {
    log.debug({ pageId: page.id, event: input.event }, 'no subscriber to notify')
    return null
  }

  const auto = page.subscriptions?.deliveryMode === 'auto'
  const now = new Date().toISOString()
  let doc: SubscriberNotification
  try {
    doc = (await payload.create({
      collection: 'subscriber-notifications',
      data: {
        organization: relId(page.organization) as SubscriberNotification['organization'],
        statusPage: page.id,
        dedupeKey: input.dedupeKey,
        event: input.event,
        state: auto ? 'sending' : 'pending_review',
        title: input.title,
        status: input.status,
        message: input.message,
        components: input.components,
        occurredAt: input.occurredAt,
        window: {
          start: input.window?.start ?? null,
          end: input.window?.end ?? null,
          reminderMinutes: input.window?.reminderMinutes ?? null,
        },
        incident: (input.incident ?? null) as SubscriberNotification['incident'],
        incidentUpdateId: input.incidentUpdateId ?? null,
        maintenance: (input.maintenance ?? null) as SubscriberNotification['maintenance'],
        occurrence: (input.occurrence ?? null) as SubscriberNotification['occurrence'],
        recipientCount: recipients.total,
        ...(auto ? { sendingStartedAt: now } : {}),
      },
      depth: 0,
      overrideAccess: true,
    })) as SubscriberNotification
  } catch (err) {
    // Lost a race with another process recording the same event: theirs wins.
    const raced = await payload.count({
      collection: 'subscriber-notifications',
      where: { dedupeKey: { equals: input.dedupeKey } },
      overrideAccess: true,
    })
    if (raced.totalDocs > 0) return null
    throw err
  }
  log.info(
    { notificationId: doc.id, pageId: page.id, event: input.event, state: doc.state },
    'subscriber notification created',
  )
  if (auto) await enqueueSubscriberJobs([fanoutJob(doc.id)])
  return doc
}

// ---------------------------------------------------------------------------------------------
// Review actions

export type BatchAction = 'send' | 'discard' | 'retry'

export class BatchStateError extends Error {
  readonly action: BatchAction
  constructor(action: BatchAction) {
    super(`Cannot ${action} this notification in its current state`)
    this.name = 'BatchStateError'
    this.action = action
  }
}

const ALLOWED: Record<BatchAction, readonly NotificationBatchState[]> = {
  send: ['pending_review'],
  discard: ['pending_review'],
  retry: ['failed', 'partially_failed'],
}

export async function applyBatchAction(
  payload: Payload,
  notification: SubscriberNotification,
  action: BatchAction,
  userId: Id | null,
): Promise<SubscriberNotification> {
  if (!ALLOWED[action].includes(notification.state)) throw new BatchStateError(action)
  const now = new Date().toISOString()

  if (action === 'discard') {
    return (await payload.update({
      collection: 'subscriber-notifications',
      id: notification.id,
      data: {
        state: 'discarded',
        discardedAt: now,
        discardedBy: userId as SubscriberNotification['discardedBy'],
      },
      depth: 0,
      overrideAccess: true,
    })) as SubscriberNotification
  }

  if (action === 'send') {
    const doc = (await payload.update({
      collection: 'subscriber-notifications',
      id: notification.id,
      data: {
        state: 'sending',
        approvedAt: now,
        approvedBy: userId as SubscriberNotification['approvedBy'],
        sendingStartedAt: now,
      },
      depth: 0,
      overrideAccess: true,
    })) as SubscriberNotification
    await enqueueSubscriberJobs([fanoutJob(doc.id)])
    return doc
  }

  // retry: failed deliveries go back to the queue with a new job id.
  const { docs: failed } = await payload.find({
    collection: 'subscriber-deliveries',
    where: {
      and: [{ notification: { equals: notification.id } }, { state: { equals: 'failed' } }],
    },
    depth: 0,
    limit: 0,
    pagination: false,
    overrideAccess: true,
    select: { state: true },
  })
  const doc = (await payload.update({
    collection: 'subscriber-notifications',
    id: notification.id,
    data: { state: 'sending', completedAt: null },
    depth: 0,
    overrideAccess: true,
  })) as SubscriberNotification
  if (failed.length > 0) {
    await payload.update({
      collection: 'subscriber-deliveries',
      where: { id: { in: failed.map((row) => row.id) } },
      data: { state: 'queued', error: null },
      depth: 0,
      overrideAccess: true,
    })
  }
  const round = Date.now().toString(36)
  await enqueueSubscriberJobs(failed.map((row) => deliveryJob(row.id, round)))
  if (failed.length === 0) await completeBatchIfDone(payload, doc.id)
  return doc
}

// ---------------------------------------------------------------------------------------------
// Delivery statistics

export type DeliveryCounts = Record<SubscriberDelivery['state'], number> & { total: number }

export async function deliveryCounts(
  payload: Payload,
  notificationId: Id,
): Promise<DeliveryCounts> {
  const states = ['queued', 'retrying', 'sent', 'failed', 'skipped'] as const
  const counts = await Promise.all(
    states.map((state) =>
      payload.count({
        collection: 'subscriber-deliveries',
        where: {
          and: [{ notification: { equals: notificationId } }, { state: { equals: state } }],
        },
        overrideAccess: true,
      }),
    ),
  )
  const result = { total: 0 } as DeliveryCounts
  states.forEach((state, i) => {
    result[state] = counts[i].totalDocs
    result.total += counts[i].totalDocs
  })
  return result
}

/**
 * Sets the final state once no delivery is pending: `sent` (nothing failed), `failed` (nothing
 * sent) or `partially_failed`. Safe to call concurrently: every caller computes the same result.
 */
export async function completeBatchIfDone(payload: Payload, notificationId: Id): Promise<void> {
  const counts = await deliveryCounts(payload, notificationId)
  if (counts.queued + counts.retrying > 0) return
  const state: NotificationBatchState =
    counts.failed === 0 ? 'sent' : counts.sent === 0 ? 'failed' : 'partially_failed'
  await payload.update({
    collection: 'subscriber-notifications',
    where: { and: [{ id: { equals: notificationId } }, { state: { equals: 'sending' } }] },
    data: { state, completedAt: new Date().toISOString() },
    depth: 0,
    overrideAccess: true,
  })
}

// ---------------------------------------------------------------------------------------------
// Rendering context

export interface PageContext {
  page: StatusPage
  i18n: OrganizationI18n
  names: Map<string, string>
}

export async function loadPageContext(payload: Payload, pageId: Id): Promise<PageContext | null> {
  const page = (await payload.findByID({
    collection: 'status-pages',
    id: pageId,
    depth: 0,
    overrideAccess: true,
    disableErrors: true,
  })) as StatusPage | null
  if (!page) return null
  const [i18n, names] = await Promise.all([
    getOrganizationI18n(payload, relId(page.organization)),
    componentNames(payload, page),
  ])
  return { page, i18n, names }
}

/** Language of a subscriber's messages: theirs, else the page's fixed language, else the org's. */
export function subscriberLocale(
  subscriber: Pick<StatusPageSubscriber, 'locale'> | null,
  ctx: PageContext,
): Locale {
  if (subscriber?.locale) return toLocale(subscriber.locale)
  const language = ctx.page.language
  if (language && language !== 'auto') return toLocale(language)
  return ctx.i18n.locale
}

export interface BatchPreview {
  email: RenderedEmail
  sms: string
  recipients: RecipientCounts
  /** SMS subscribers exist but the page has no Twilio channel: their deliveries will fail. */
  smsUnavailable: boolean
  announcement: Announcement
}

/** What the draft view shows: the rendered email and SMS and the estimated recipients. */
export async function previewBatch(
  payload: Payload,
  notification: SubscriberNotification,
  ctx: PageContext,
): Promise<BatchPreview> {
  const announcement = toAnnouncement(notification, ctx.page, ctx.names)
  const locale = subscriberLocale(null, ctx)
  const render = { locale, i18n: ctx.i18n }
  const links = subscriptionLinks(ctx.page, {
    id: 'preview' as unknown as StatusPageSubscriber['id'],
    token: '',
  })
  const [recipients, smsChannel] = await Promise.all([
    countRecipients(payload, ctx.page.id, notification.components),
    loadSmsChannel(payload, ctx.page),
  ])
  return {
    email: renderAnnouncementEmail(announcement, links, render),
    sms: renderSms(announcement, render, {
      templates: ctx.page.subscriptions?.smsTemplates,
      maxSegments: ctx.page.subscriptions?.smsMaxSegments,
    }),
    recipients,
    smsUnavailable: recipients.sms > 0 && !smsChannel,
    announcement,
  }
}
