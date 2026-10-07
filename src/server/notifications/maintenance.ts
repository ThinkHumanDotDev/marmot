/**
 * Maintenance windows on notification channels (#126): when an occurrence starts or completes, the
 * channels that accept the opt-in `maintenance` event and are attached to one of its monitors get
 * one message each, through the notifications queue (job `notify-maintenance`).
 *
 * The listener runs in whichever process moved the maintenance (`dispatchMaintenanceEvents`: the
 * worker for automatic transitions, the web process for an admin's update) and only enqueues; the
 * worker renders and sends. Job ids (`notif-maint:<channel>:<occurrence>:<type>`) dedupe a repeated
 * event.
 */
import type { Queue } from 'bullmq'
import type { Payload, Where } from 'payload'

import type { Locale } from '@/i18n/locales'
import { childLogger } from '@/lib/logger'
import type { Monitor, Notification } from '@/payload-types'
import {
  registerMaintenanceEventListener,
  type MaintenanceEvent,
  type MaintenanceEventType,
} from '@/server/maintenance/events'
import { MAX_GROUP_DEPTH } from '@/server/maintenance/resolver'
import { serverTranslator } from '@/server/i18n'
import {
  channelsAcceptingEvent,
  getNotificationsQueue,
  NOTIFICATION_JOB_OPTIONS,
  type EnqueueOptions,
} from './dispatch'
import { statusLabel } from './message'

const log = childLogger('notifications:maintenance')

/** Job name of a maintenance message on the notifications queue. */
export const MAINTENANCE_NOTIFICATION_JOB_NAME = 'notify-maintenance' as const

/** Maintenance events that reach channels: the window starts and ends. */
export type ChannelMaintenanceEventType = Extract<MaintenanceEventType, 'started' | 'completed'>

export const isChannelMaintenanceEvent = (
  type: MaintenanceEventType,
): type is ChannelMaintenanceEventType => type === 'started' || type === 'completed'

export interface MaintenanceNotificationJobData {
  notificationId: string
  organizationId: string
  type: ChannelMaintenanceEventType
  title: string
  occurrenceId: string
  /** Monitors of the window this channel is attached to (names are resolved when sending). */
  monitorIds: string[]
}

export const maintenanceJobId = (
  notificationId: string | number,
  occurrenceId: string | number,
  type: ChannelMaintenanceEventType,
): string => `notif-maint:${notificationId}:${occurrenceId}:${type}`

type MaintenanceQueue = Queue<
  MaintenanceNotificationJobData,
  void,
  typeof MAINTENANCE_NOTIFICATION_JOB_NAME
>

/** Ids in events and jobs are strings; Postgres relationships want numbers. */
export const docIdFromString = (payload: Payload, id: string): string | number =>
  payload.db.defaultIDType === 'number' && /^\d+$/.test(id) ? Number(id) : id

const relationIds = (value: Monitor['notifications']): string[] =>
  (value ?? []).map((item) =>
    String(typeof item === 'object' && item !== null ? (item as Notification).id : item),
  )

/**
 * Monitors a maintenance covers: the listed ones plus the children of listed groups (recursively,
 * as `isMonitorUnderMaintenance` resolves them), in the maintenance's organization.
 */
export async function maintenanceMonitors(
  payload: Payload,
  organizationId: string,
  monitorIds: readonly string[],
): Promise<Monitor[]> {
  const found = new Map<string, Monitor>()
  let frontier = [...new Set(monitorIds.map(String))]
  const org = docIdFromString(payload, organizationId)
  for (let depth = 0; frontier.length > 0 && depth <= MAX_GROUP_DEPTH; depth++) {
    const ids = frontier.map((id) => docIdFromString(payload, id))
    const where: Where = {
      and: [
        depth === 0 ? { id: { in: ids } } : { parent: { in: ids } },
        { organization: { equals: org } },
      ],
    }
    const { docs } = await payload.find({
      collection: 'monitors',
      where,
      depth: 0,
      limit: 0,
      pagination: false,
      overrideAccess: true,
      select: { name: true, type: true, notifications: true },
    })
    frontier = []
    for (const doc of docs as Monitor[]) {
      const key = String(doc.id)
      if (found.has(key)) continue
      found.set(key, doc)
      if (doc.type === 'group') frontier.push(key)
    }
  }
  return [...found.values()]
}

export type EnqueueMaintenanceOptions = Pick<EnqueueOptions, 'queue'>

/**
 * Enqueue one `notify-maintenance` job per active channel that accepts `maintenance` and is
 * attached to a monitor of the window. Other maintenance events (scheduled, reminders, notes,
 * cancellations) stay with status page subscribers. Returns the number of channels.
 */
export async function enqueueMaintenanceNotifications(
  payload: Payload,
  event: MaintenanceEvent,
  options: EnqueueMaintenanceOptions = {},
): Promise<number> {
  if (!isChannelMaintenanceEvent(event.type)) return 0
  const type = event.type
  const monitors = await maintenanceMonitors(
    payload,
    event.organizationId,
    event.maintenance.monitors,
  )
  const monitorsByChannel = new Map<string, string[]>()
  for (const monitor of monitors) {
    for (const channelId of relationIds(monitor.notifications)) {
      const list = monitorsByChannel.get(channelId) ?? []
      list.push(String(monitor.id))
      monitorsByChannel.set(channelId, list)
    }
  }
  if (monitorsByChannel.size === 0) return 0

  const { docs } = await payload.find({
    collection: 'notifications',
    where: {
      and: [
        { id: { in: [...monitorsByChannel.keys()].map((id) => docIdFromString(payload, id)) } },
        { organization: { equals: docIdFromString(payload, event.organizationId) } },
        { active: { equals: true } },
      ],
    },
    depth: 0,
    limit: 0,
    pagination: false,
    overrideAccess: true,
  })
  const channels = channelsAcceptingEvent(docs as Notification[], 'maintenance')
  if (channels.length === 0) return 0

  const queue = (options.queue ?? getNotificationsQueue()) as unknown as MaintenanceQueue
  await queue.addBulk(
    channels.map((channel) => ({
      name: MAINTENANCE_NOTIFICATION_JOB_NAME,
      data: {
        notificationId: String(channel.id),
        organizationId: event.organizationId,
        type,
        title: event.maintenance.title,
        occurrenceId: event.occurrence.id,
        monitorIds: monitorsByChannel.get(String(channel.id)) ?? [],
      },
      opts: {
        ...NOTIFICATION_JOB_OPTIONS,
        jobId: maintenanceJobId(channel.id, event.occurrence.id, type),
      },
    })),
  )
  log.debug(
    { occurrenceId: event.occurrence.id, type, channels: channels.length },
    'maintenance notification jobs enqueued',
  )
  return channels.length
}

/**
 * `[Marmot] [🔧 Maintenance] Maintenance "DB upgrade" started for API and Web.` in `locale`
 * (`notifications.messages.maintenanceStarted|Completed`).
 */
export function buildMaintenanceMessage(
  type: ChannelMaintenanceEventType,
  title: string,
  monitorNames: readonly string[],
  locale: Locale,
): string {
  const t = serverTranslator(locale)
  const monitors = new Intl.ListFormat(locale, { type: 'conjunction' }).format(monitorNames)
  const text =
    type === 'started'
      ? t('notifications.messages.maintenanceStarted', { title, monitors })
      : t('notifications.messages.maintenanceCompleted', { title, monitors })
  return `[Marmot] [${statusLabel('maintenance', locale)}] ${text}`
}

let unsubscribe: (() => void) | null = null

/**
 * Turn maintenance starts and ends into channel notifications, once per process (Payload's
 * `onInit`, next to the subscriber listeners). Returns the unsubscribe function.
 */
export function registerMaintenanceChannelListener(): () => void {
  if (unsubscribe) return unsubscribe
  const off = registerMaintenanceEventListener(async (event, payload) => {
    if (!isChannelMaintenanceEvent(event.type)) return
    try {
      await enqueueMaintenanceNotifications(payload, event)
    } catch (err) {
      log.error(
        { err, occurrenceId: event.occurrence.id },
        'cannot enqueue maintenance notifications',
      )
    }
  })
  unsubscribe = () => {
    off()
    unsubscribe = null
  }
  return unsubscribe
}
