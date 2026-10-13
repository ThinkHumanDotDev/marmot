/**
 * Declared-incident notifications (#101), through the same queue and providers as every other
 * notification:
 *
 *   collection afterChange / reminder job ─▶ `enqueueDeclaredNotifications`
 *     ─▶ BullMQ `marmot:notifications`, job `declared-incident-notify`
 *     ─▶ notification worker ─▶ `processDeclaredNotificationJob`
 *        ─▶ `sendNotification` (channels) or the email adapter (the commander)
 *
 * Channels: every active channel of the organization that opted into the `incident` channel event
 * hears about declarations, status changes, new commanders and reminders. The commander: an email
 * when assigned (unless they assigned themselves) and for each reminder.
 */
import type { JobsOptions, Queue } from 'bullmq'
import type { Payload } from 'payload'

import { env } from '@/env'
import { defaultLocale, type Locale } from '@/i18n/locales'
import type { DeclaredIncidentSummary, DeclaredNotificationEvent } from '@/lib/declared-incidents'
import { childLogger } from '@/lib/logger'
import { humanDuration } from '@/lib/validation/monitor'
import type { DeclaredIncident, Notification, User } from '@/payload-types'
import { getOrganizationI18n, serverTranslator } from '@/server/i18n'
import {
  channelAcceptsEvent,
  getNotificationsQueue,
  NOTIFICATION_JOB_OPTIONS,
} from '@/server/notifications/dispatch'
import { getChannelOrganization, sendNotification } from '@/server/notifications/send'

import { relId, type Id } from './ids'
import { serializeDeclaredIncident } from './store'

const log = childLogger('declared-incidents:notify')

export const DECLARED_NOTIFICATION_JOB = 'declared-incident-notify' as const

export type DeclaredNotificationTarget = { channel: string } | { commander: string }

export interface DeclaredNotificationJobData {
  incidentId: string
  organizationId: string
  event: DeclaredNotificationEvent
  target: DeclaredNotificationTarget
}

export interface DeclaredNotificationJob {
  name: typeof DECLARED_NOTIFICATION_JOB
  data: DeclaredNotificationJobData
  opts: JobsOptions & { jobId: string }
}

export const isDeclaredJobName = (name: string): name is typeof DECLARED_NOTIFICATION_JOB =>
  name === DECLARED_NOTIFICATION_JOB

/** Where jobs go: BullMQ by default, a recorder or an inline runner in tests. */
export type DeclaredJobSink = (jobs: DeclaredNotificationJob[]) => Promise<void>

const bullSink: DeclaredJobSink = async (jobs) => {
  const queue = getNotificationsQueue() as unknown as Queue<
    DeclaredNotificationJobData,
    void,
    typeof DECLARED_NOTIFICATION_JOB
  >
  await queue.addBulk(jobs)
}

let sink: DeclaredJobSink | null = null

/** Replace the job sink (tests); `null` restores BullMQ. */
export function setDeclaredJobSink(next: DeclaredJobSink | null): void {
  sink = next
}

/** BullMQ job ids may not contain `:`; the stamp keeps repeated events (status changes) apart. */
const jobId = (target: DeclaredNotificationTarget, incidentId: Id, event: string, stamp: string) =>
  `dinc-${'channel' in target ? `c${target.channel}` : `u${target.commander}`}-${incidentId}-${event}-${stamp}`.replace(
    /[^A-Za-z0-9_-]/g,
    '-',
  )

/** Active channels of the organization that follow declared incidents. */
async function incidentChannels(payload: Payload, orgId: Id): Promise<Notification[]> {
  const { docs } = await payload.find({
    collection: 'notifications',
    where: { and: [{ organization: { equals: orgId } }, { active: { equals: true } }] },
    limit: 0,
    pagination: false,
    depth: 0,
    overrideAccess: true,
  })
  return (docs as Notification[]).filter((channel) => channelAcceptsEvent(channel, 'incident'))
}

/** Enqueues the jobs of one event. Never throws (a broken queue must not fail the write). */
export async function enqueueDeclaredNotifications(
  payload: Payload,
  incident: DeclaredIncident,
  event: DeclaredNotificationEvent,
  options: { actorId?: Id | null } = {},
): Promise<number> {
  try {
    const orgId = relId(incident.organization)
    if (orgId === null) return 0
    const targets: DeclaredNotificationTarget[] = (await incidentChannels(payload, orgId)).map(
      (channel) => ({ channel: String(channel.id) }),
    )
    const commander = relId(incident.commander)
    const tellCommander =
      event === 'reminder' ||
      (event === 'commander' && String(commander) !== String(options.actorId ?? ''))
    if (commander !== null && tellCommander) targets.push({ commander: String(commander) })
    if (targets.length === 0) return 0
    const stamp =
      event === 'reminder'
        ? `r${incident.remindersSent ?? 0}-${Date.parse(incident.lastReminderAt ?? '') || 0}`
        : String(Date.parse(incident.updatedAt) || Date.now())
    await (sink ?? bullSink)(
      targets.map((target) => ({
        name: DECLARED_NOTIFICATION_JOB,
        data: {
          incidentId: String(incident.id),
          organizationId: String(orgId),
          event,
          target,
        },
        opts: { ...NOTIFICATION_JOB_OPTIONS, jobId: jobId(target, incident.id, event, stamp) },
      })),
    )
    return targets.length
  } catch (err) {
    log.error({ err, incidentId: incident.id, event }, 'failed to enqueue incident notifications')
    return 0
  }
}

/** Dashboard link of an incident. */
export const declaredIncidentUrl = (orgSlug: string, incidentId: Id): string =>
  `${env.NEXT_PUBLIC_SERVER_URL.replace(/\/+$/, '')}/${orgSlug}/declared-incidents/${incidentId}`

/**
 * `[title] [🚨 Declared] Critical incident declared. Commander: Ada.` in the organization's
 * language, the `[name] [label] text` shape of every Marmot notification.
 */
export function buildDeclaredMessage(
  incident: Pick<
    DeclaredIncidentSummary,
    'title' | 'severity' | 'status' | 'commander' | 'lastActivityAt'
  >,
  event: DeclaredNotificationEvent,
  locale: Locale = defaultLocale,
  options: { url?: string | null; now?: Date } = {},
): string {
  const t = serverTranslator(locale)
  const severity = t(`declaredIncidents.severity.${incident.severity}`)
  const status = t(`declaredIncidents.status.${incident.status}`)
  let text: string
  if (event === 'declared') {
    text = t('notifications.messages.declaredIncident.declared', { severity })
  } else if (event === 'status') {
    text = t('notifications.messages.declaredIncident.status', { status })
  } else if (event === 'commander') {
    text = t('notifications.messages.declaredIncident.commander', {
      name: incident.commander?.name ?? '',
    })
  } else {
    const since = Date.parse(incident.lastActivityAt ?? '')
    const seconds = Number.isFinite(since)
      ? Math.max(60, Math.round(((options.now ?? new Date()).getTime() - since) / 60_000) * 60)
      : 0
    text = t('notifications.messages.declaredIncident.reminder', {
      duration: humanDuration(seconds, (unit, count) => t(`common.duration.${unit}`, { count })),
    })
  }
  if (event !== 'commander' && incident.commander) {
    text += ` ${t('notifications.messages.declaredIncident.commanderIs', { name: incident.commander.name })}`
  }
  if (options.url) text += ` ${options.url}`
  const label = t(`notifications.messages.declaredIncident.label.${event}`)
  return `[${incident.title}] [${label}] ${text}`
}

export interface ProcessDeclaredResult {
  outcome: 'sent' | 'skipped'
  reason?: string
}

/** Worker side: load the incident and the target, render and send. Throws so BullMQ retries. */
export async function processDeclaredNotificationJob(
  payload: Payload,
  job: { data: DeclaredNotificationJobData },
): Promise<ProcessDeclaredResult> {
  const { incidentId, event, target, organizationId } = job.data
  const doc = (await payload
    .findByID({ collection: 'declared-incidents', id: incidentId, depth: 0, overrideAccess: true })
    .catch(() => null)) as DeclaredIncident | null
  if (!doc) return { outcome: 'skipped', reason: 'incident-not-found' }
  const incident = await serializeDeclaredIncident(payload, doc)

  if ('channel' in target) {
    const channel = (await payload
      .findByID({ collection: 'notifications', id: target.channel, depth: 0, overrideAccess: true })
      .catch(() => null)) as Notification | null
    if (!channel) return { outcome: 'skipped', reason: 'notification-not-found' }
    if (!channel.active) return { outcome: 'skipped', reason: 'inactive' }
    if (!channelAcceptsEvent(channel, 'incident')) {
      return { outcome: 'skipped', reason: 'event-filtered' }
    }
    const org = await getChannelOrganization(payload, channel)
    const url = org.organization ? declaredIncidentUrl(org.organization.slug, doc.id) : null
    await sendNotification(payload, channel, {
      message: buildDeclaredMessage(incident, event, org.locale, { url }),
      monitor: null,
      heartbeat: null,
      event: 'incident',
      channelOrganization: org,
    })
    log.info({ incidentId, event, notificationId: target.channel }, 'incident notification sent')
    return { outcome: 'sent' }
  }

  const user = (await payload
    .findByID({ collection: 'users', id: target.commander, depth: 0, overrideAccess: true })
    .catch(() => null)) as User | null
  if (!user?.email) return { outcome: 'skipped', reason: 'commander-not-found' }
  // The commander may have changed since the job was enqueued.
  if (String(relId(doc.commander)) !== String(user.id)) {
    return { outcome: 'skipped', reason: 'commander-changed' }
  }
  const { locale } = await getOrganizationI18n(payload, organizationId)
  const org = await payload
    .findByID({
      collection: 'organizations',
      id: organizationId,
      depth: 0,
      overrideAccess: true,
      select: { slug: true },
    })
    .catch(() => null)
  const url = org?.slug ? declaredIncidentUrl(org.slug, doc.id) : null
  const t = serverTranslator(locale)
  await payload.sendEmail({
    to: user.email,
    subject: t('notifications.messages.declaredIncident.emailSubject', {
      label: t(`notifications.messages.declaredIncident.label.${event}`),
      title: incident.title,
    }),
    text: buildDeclaredMessage(incident, event, locale, { url }),
  })
  log.info({ incidentId, event, userId: user.id }, 'incident commander emailed')
  return { outcome: 'sent' }
}
