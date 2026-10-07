/**
 * Incident notifications (#100): acknowledging or resolving an incident by hand tells the monitor's
 * channels, through the same queue and providers as heartbeat notifications.
 *
 *   acknowledgeIncident / resolve route ─▶ `enqueueIncidentNotifications`
 *     ─▶ BullMQ `marmot:notifications`, job `incident-notify` (id `inc-<channel>-<incident>-<event>`)
 *     ─▶ notification worker ─▶ `processIncidentNotificationJob` ─▶ `sendNotification`
 *
 * Event names are stable (`INCIDENT_NOTIFICATION_EVENTS`: `acknowledged`, `resolved`) so per-channel
 * event filters (#126) can select them; `channelAcceptsIncidentEvent` is the single filter point.
 * An automatic resolution sends nothing extra: the recovery (UP) notification already announces it.
 */
import type { JobsOptions, Queue } from 'bullmq'
import type { Payload } from 'payload'

import { defaultLocale, type Locale } from '@/i18n/locales'
import { childLogger } from '@/lib/logger'
import {
  incidentDurationSeconds,
  type IncidentNotificationEvent,
  type MonitorIncidentSummary,
} from '@/lib/monitor-incidents'
import { humanDuration } from '@/lib/validation/monitor'
import type { Monitor, MonitorIncident, Notification } from '@/payload-types'
import { serverTranslator } from '@/server/i18n'
import {
  getMonitorNotifications,
  getNotificationsQueue,
  NOTIFICATION_JOB_OPTIONS,
} from '@/server/notifications/dispatch'
import { getChannelLocale, sendNotification } from '@/server/notifications/send'

import { getIncident, relId, serializeIncident } from './store'

const log = childLogger('incidents:notify')

export const INCIDENT_NOTIFICATION_JOB = 'incident-notify' as const

export interface IncidentNotificationJobData {
  notificationId: string
  incidentId: string
  event: IncidentNotificationEvent
  organizationId: string | null
}

export const isIncidentJobName = (name: string): name is typeof INCIDENT_NOTIFICATION_JOB =>
  name === INCIDENT_NOTIFICATION_JOB

export const incidentJobId = (
  notificationId: string | number,
  incidentId: string | number,
  event: IncidentNotificationEvent,
) => `inc-${notificationId}-${incidentId}-${event}`

/**
 * Does `channel` want `event`? Every channel does until per-channel event filters land (#126),
 * which replace this with the channel's own selection.
 */
export function channelAcceptsIncidentEvent(
  _channel: Pick<Notification, 'id'>,
  _event: IncidentNotificationEvent,
): boolean {
  return true
}

export interface IncidentJob {
  name: typeof INCIDENT_NOTIFICATION_JOB
  data: IncidentNotificationJobData
  opts: JobsOptions & { jobId: string }
}

/** Where jobs go: BullMQ by default, an inline runner or a recorder in tests. */
export type IncidentJobSink = (jobs: IncidentJob[]) => Promise<void>

const bullSink: IncidentJobSink = async (jobs) => {
  const queue = getNotificationsQueue() as unknown as Queue<
    IncidentNotificationJobData,
    void,
    typeof INCIDENT_NOTIFICATION_JOB
  >
  await queue.addBulk(jobs)
}

let sink: IncidentJobSink | null = null

/** Replace the job sink (tests); `null` restores BullMQ. */
export function setIncidentJobSink(next: IncidentJobSink | null): void {
  sink = next
}

/** One job per active channel of the incident's monitor that accepts `event`. Never throws. */
export async function enqueueIncidentNotifications(
  payload: Payload,
  incident: MonitorIncident,
  event: IncidentNotificationEvent,
): Promise<number> {
  try {
    const monitorId = relId(incident.monitor)
    if (monitorId === null) return 0
    const monitor = (await payload.findByID({
      collection: 'monitors',
      id: monitorId,
      depth: 0,
      overrideAccess: true,
    })) as Monitor
    const channels = (await getMonitorNotifications(payload, monitor)).filter((channel) =>
      channelAcceptsIncidentEvent(channel, event),
    )
    if (channels.length === 0) return 0
    const organizationId = relId(incident.organization)
    await (sink ?? bullSink)(
      channels.map((channel) => ({
        name: INCIDENT_NOTIFICATION_JOB,
        data: {
          notificationId: String(channel.id),
          incidentId: String(incident.id),
          event,
          organizationId: organizationId === null ? null : String(organizationId),
        },
        opts: { ...NOTIFICATION_JOB_OPTIONS, jobId: incidentJobId(channel.id, incident.id, event) },
      })),
    )
    return channels.length
  } catch (err) {
    log.error({ err, incidentId: incident.id, event }, 'failed to enqueue incident notifications')
    return 0
  }
}

/**
 * `[name] [👀 Acknowledged] Acknowledged by Ada.` in the organization's language; the
 * `[name] [label] text` shape is the same as heartbeat notifications.
 */
export function buildIncidentMessage(
  monitorName: string,
  incident: Pick<
    MonitorIncidentSummary,
    'startedAt' | 'resolvedAt' | 'acknowledgedBy' | 'acknowledgedVia' | 'resolvedBy' | 'timeline'
  >,
  event: IncidentNotificationEvent,
  locale: Locale = defaultLocale,
): string {
  const t = serverTranslator(locale)
  const duration = humanDuration(incidentDurationSeconds(incident), (unit, count) =>
    t(`common.duration.${unit}`, { count }),
  )
  let text: string
  if (event === 'acknowledged') {
    text = incident.acknowledgedBy
      ? t('notifications.messages.incident.acknowledgedBy', { name: incident.acknowledgedBy.name })
      : incident.acknowledgedVia === 'link'
        ? t('notifications.messages.incident.acknowledgedViaLink')
        : t('notifications.messages.incident.acknowledged')
  } else {
    text = incident.resolvedBy
      ? t('notifications.messages.incident.resolvedBy', {
          name: incident.resolvedBy.name,
          duration,
        })
      : t('notifications.messages.incident.resolved', { duration })
  }
  const note = [...incident.timeline].reverse().find((entry) => entry.type === event)?.message
  if (note) text += ` ${t('notifications.messages.incident.note', { note })}`
  const label = t(`notifications.messages.incident.label.${event}`)
  return `[${monitorName}] [${label}] ${text}`
}

export interface ProcessIncidentNotificationResult {
  outcome: 'sent' | 'skipped'
  reason?: string
}

/** Worker side: load channel, incident and monitor, render and send. Throws so BullMQ retries. */
export async function processIncidentNotificationJob(
  payload: Payload,
  job: { data: IncidentNotificationJobData },
): Promise<ProcessIncidentNotificationResult> {
  const { notificationId, incidentId, event } = job.data
  const notification = (await payload
    .findByID({ collection: 'notifications', id: notificationId, depth: 0, overrideAccess: true })
    .catch(() => null)) as Notification | null
  if (!notification) return { outcome: 'skipped', reason: 'notification-not-found' }
  if (!notification.active) return { outcome: 'skipped', reason: 'inactive' }
  const incident = await getIncident(payload, incidentId)
  if (!incident) return { outcome: 'skipped', reason: 'incident-not-found' }
  const monitorId = relId(incident.monitor)
  const monitor =
    monitorId === null
      ? null
      : ((await payload
          .findByID({ collection: 'monitors', id: monitorId, depth: 0, overrideAccess: true })
          .catch(() => null)) as Monitor | null)
  if (!monitor) return { outcome: 'skipped', reason: 'monitor-not-found' }

  const summary = await serializeIncident(payload, incident)
  const locale = await getChannelLocale(payload, notification)
  const message = buildIncidentMessage(monitor.name, summary, event, locale)
  await sendNotification(payload, notification, { message, monitor, heartbeat: null, locale })
  log.info({ notificationId, incidentId, event }, 'incident notification sent')
  return { outcome: 'sent' }
}
