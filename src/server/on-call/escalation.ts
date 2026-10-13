/**
 * Escalation of monitor incidents (#145), as BullMQ jobs on `marmot:escalations`:
 *
 *   incident opened (monitor has a policy) ─▶ `startEscalation`
 *     ─▶ job `escalation-step` (step 0, no delay)
 *     ─▶ `processEscalationStep`: resolve the step's targets (the member on call in a schedule, a
 *        member, a notification channel), enqueue one `escalation-page` job per target, append an
 *        `escalated` row to the timeline, and enqueue the next step delayed by the step's
 *        `escalateAfterMinutes` (after the last step: step 0 of the next round while
 *        `repeat` allows, else the escalation is `exhausted`)
 *     ─▶ `processEscalationPage`: email the member, or send to the channel through its provider,
 *        with the signed acknowledge link
 *
 * Delayed jobs live in Redis, so a pending step survives worker restarts; job ids are derived from
 * (incident, round, step), so a step is never queued twice. Acknowledging or resolving the incident
 * marks the escalation `stopped` (`src/server/incidents/store.ts`) and removes the pending job
 * (`cancelEscalation`); every job also re-checks the incident first, so a job that slips through
 * (or a page queued just before the acknowledgement) pages nobody.
 *
 * Phone calls (#146) and other channels plug in as notification channel types: a `channel` target
 * accepts any provider.
 */
import type { Job, Queue } from 'bullmq'
import type { Payload } from 'payload'

import { getUserRole } from '@/access/permissions'
import { env } from '@/env'
import { defaultLocale, type Locale } from '@/i18n/locales'
import { childLogger } from '@/lib/logger'
import { nextEscalationStep, stoppedEscalation, type EscalationTargetType } from '@/lib/on-call'
import type {
  EscalationPolicy,
  Monitor,
  MonitorIncident,
  Notification,
  OnCallSchedule,
  User,
} from '@/payload-types'
import { QUEUE_NAMES } from '@/server/engine/names'
import { createQueue, createWorker, type QueueFactoryOptions } from '@/server/engine/queues'
import { getOrganizationI18n, serverTranslator } from '@/server/i18n'
import { ackLinkUrl } from '@/server/incidents/ack-link'
import { publishIncident } from '@/server/incidents/realtime'
import { getIncident } from '@/server/incidents/store'
import { sendNotification } from '@/server/notifications/send'

import { relId, type Id } from './ids'
import { scheduleOnCallAt, userNames } from './store'

const log = childLogger('on-call:escalation')

export const ESCALATION_STEP_JOB = 'escalation-step' as const
export const ESCALATION_PAGE_JOB = 'escalation-page' as const
export type EscalationJobName = typeof ESCALATION_STEP_JOB | typeof ESCALATION_PAGE_JOB

export interface EscalationStepJobData {
  incidentId: string
  organizationId: string
  policyId: string
  step: number
  round: number
}

export interface EscalationPageJobData {
  incidentId: string
  organizationId: string
  target: { type: 'user' | 'channel'; id: string }
  step: number
  round: number
}

export type EscalationJobData = EscalationStepJobData | EscalationPageJobData

export type EscalationsQueue = Queue<EscalationJobData, void, EscalationJobName>

/** Retries with backoff; finished jobs are kept a day for inspection. */
const JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 5_000 },
  removeOnComplete: { age: 24 * 3600, count: 5_000 },
  removeOnFail: { age: 7 * 24 * 3600 },
} as const

const safe = (value: string) => value.replace(/[^A-Za-z0-9_-]/g, '-')

/** Id of the job of one step; BullMQ refuses a second job with the same id. */
export const escalationStepJobId = (incidentId: Id, round: number, step: number) =>
  safe(`esc-${incidentId}-r${round}-s${step}`)

const pageJobId = (data: EscalationPageJobData) =>
  safe(`escp-${data.incidentId}-r${data.round}-s${data.step}-${data.target.type}${data.target.id}`)

let queue: EscalationsQueue | undefined

/** Process-wide escalations queue (lazy). */
export function getEscalationsQueue(): EscalationsQueue {
  queue ??= createQueue<EscalationJobData, void, EscalationJobName>(QUEUE_NAMES.escalations)
  return queue
}

/** Use another queue (tests: a private prefix); `null` restores the default. */
export function setEscalationsQueue(next: EscalationsQueue | null): void {
  queue = next ?? undefined
}

export async function closeEscalationsQueue(): Promise<void> {
  const current = queue
  queue = undefined
  if (current) await current.close()
}

async function enqueueStep(data: EscalationStepJobData, delayMs: number): Promise<void> {
  await getEscalationsQueue().add(ESCALATION_STEP_JOB, data, {
    ...JOB_OPTIONS,
    delay: Math.max(0, delayMs),
    jobId: escalationStepJobId(data.incidentId, data.round, data.step),
  })
}

const findPolicy = (payload: Payload, id: Id) =>
  payload
    .findByID({ collection: 'escalation-policies', id, depth: 0, overrideAccess: true })
    .catch(() => null) as Promise<EscalationPolicy | null>

/**
 * Starts the escalation of a newly opened incident when its monitor has a policy (of the same
 * organization, with steps). Returns the updated incident, or `null` when nothing escalates.
 * Never throws: a broken queue must not break the heartbeat pipeline.
 */
export async function startEscalation(
  payload: Payload,
  incident: MonitorIncident,
  monitor: Pick<Monitor, 'id' | 'organization' | 'escalationPolicy'>,
  now: Date = new Date(),
): Promise<MonitorIncident | null> {
  try {
    const policyId = relId(monitor.escalationPolicy)
    if (policyId === null) return null
    const policy = await findPolicy(payload, policyId)
    const orgId = relId(incident.organization)
    if (!policy || String(relId(policy.organization)) !== String(orgId) || !policy.steps?.length) {
      return null
    }
    const updated = (await payload.update({
      collection: 'monitor-incidents',
      id: incident.id,
      depth: 0,
      overrideAccess: true,
      data: {
        escalationPolicy: policy.id,
        escalation: { status: 'active', step: 0, round: 0, nextAt: now.toISOString() },
      },
    })) as MonitorIncident
    await enqueueStep(
      {
        incidentId: String(incident.id),
        organizationId: String(orgId),
        policyId: String(policy.id),
        step: 0,
        round: 0,
      },
      0,
    )
    log.info({ incidentId: incident.id, policyId: policy.id }, 'escalation started')
    return updated
  } catch (err) {
    log.error({ err, incidentId: incident.id }, 'failed to start the escalation')
    return null
  }
}

/**
 * Removes the pending step job of an incident's escalation (after an acknowledgement or a
 * resolution). Never throws; the job re-checks the incident anyway.
 */
export async function cancelEscalation(incident: MonitorIncident): Promise<void> {
  const escalation = incident.escalation
  if (relId(incident.escalationPolicy) === null || !escalation) return
  if (typeof escalation.step !== 'number' || typeof escalation.round !== 'number') return
  try {
    await getEscalationsQueue().remove(
      escalationStepJobId(incident.id, escalation.round, escalation.step),
    )
  } catch (err) {
    log.warn({ err, incidentId: incident.id }, 'failed to remove the pending escalation step')
  }
}

interface ResolvedTarget {
  type: 'user' | 'channel'
  id: string
  /** Shown on the timeline. */
  label: string
}

/** The concrete people and channels a step pages right now, deduplicated. */
async function resolveTargets(
  payload: Payload,
  orgId: Id,
  step: NonNullable<EscalationPolicy['steps']>[number],
  now: Date,
): Promise<ResolvedTarget[]> {
  const users: { id: string; via?: string }[] = []
  const channels: { id: string; name: string }[] = []
  for (const target of step.targets ?? []) {
    const type = target.type as EscalationTargetType
    if (type === 'user') {
      const id = relId(target.user)
      if (id !== null) users.push({ id: String(id) })
    } else if (type === 'schedule') {
      const id = relId(target.schedule)
      if (id === null) continue
      const schedule = (await payload
        .findByID({ collection: 'on-call-schedules', id, depth: 0, overrideAccess: true })
        .catch(() => null)) as OnCallSchedule | null
      if (!schedule || String(relId(schedule.organization)) !== String(orgId)) continue
      const onCall = scheduleOnCallAt(schedule, now)
      if (onCall !== null) users.push({ id: onCall, via: schedule.name })
    } else {
      const id = relId(target.channel)
      if (id === null) continue
      const channel = (await payload
        .findByID({ collection: 'notifications', id, depth: 0, overrideAccess: true })
        .catch(() => null)) as Notification | null
      if (channel?.active && String(relId(channel.organization)) === String(orgId)) {
        channels.push({ id: String(channel.id), name: channel.name })
      }
    }
  }
  const names = await userNames(
    payload,
    users.map((user) => user.id),
  )
  const seen = new Set<string>()
  const targets: ResolvedTarget[] = []
  for (const user of users) {
    if (seen.has(`u${user.id}`) || !names.has(user.id)) continue
    seen.add(`u${user.id}`)
    const name = names.get(user.id) ?? ''
    targets.push({ type: 'user', id: user.id, label: user.via ? `${name} (${user.via})` : name })
  }
  for (const channel of channels) {
    if (seen.has(`c${channel.id}`)) continue
    seen.add(`c${channel.id}`)
    targets.push({ type: 'channel', id: channel.id, label: channel.name })
  }
  return targets
}

export interface EscalationStepResult {
  outcome: 'paged' | 'stopped' | 'stale'
  targets?: ResolvedTarget[]
  next?: { step: number; round: number; delayMs: number } | null
}

type TimelineRow = NonNullable<MonitorIncident['timeline']>[number]

async function markStopped(payload: Payload, incident: MonitorIncident): Promise<void> {
  const escalation = stoppedEscalation(incident)
  if (!escalation) return
  await payload.update({
    collection: 'monitor-incidents',
    id: incident.id,
    depth: 0,
    overrideAccess: true,
    data: { escalation },
  })
}

/** Worker side of `escalation-step`. Throws on infrastructure errors so BullMQ retries. */
export async function processEscalationStep(
  payload: Payload,
  data: EscalationStepJobData,
  now: Date = new Date(),
): Promise<EscalationStepResult> {
  const incident = await getIncident(payload, data.incidentId)
  if (!incident) return { outcome: 'stale' }
  const escalation = incident.escalation
  if (incident.status !== 'open') {
    await markStopped(payload, incident)
    return { outcome: 'stopped' }
  }
  if (
    escalation?.status !== 'active' ||
    escalation.step !== data.step ||
    escalation.round !== data.round ||
    String(relId(incident.escalationPolicy)) !== data.policyId
  ) {
    return { outcome: 'stale' }
  }
  const policy = await findPolicy(payload, data.policyId)
  const step = policy?.steps?.[data.step]
  if (!policy || !step) {
    await markStopped(payload, incident)
    return { outcome: 'stopped' }
  }

  const targets = await resolveTargets(payload, data.organizationId, step, now)
  if (targets.length > 0) {
    await getEscalationsQueue().addBulk(
      targets.map((target) => {
        const page: EscalationPageJobData = {
          incidentId: data.incidentId,
          organizationId: data.organizationId,
          target: { type: target.type, id: target.id },
          step: data.step,
          round: data.round,
        }
        return {
          name: ESCALATION_PAGE_JOB,
          data: page,
          opts: { ...JOB_OPTIONS, jobId: pageJobId(page) },
        }
      }),
    )
  } else {
    log.warn({ incidentId: incident.id, step: data.step }, 'escalation step reached nobody')
  }

  const following = nextEscalationStep(
    policy.steps?.length ?? 0,
    policy.repeat ?? 0,
    data.step,
    data.round,
  )
  const delayMs = Math.max(1, step.escalateAfterMinutes) * 60_000
  const row = {
    type: 'escalated',
    at: now.toISOString(),
    by: null,
    via: null,
    message:
      targets
        .map((target) => target.label)
        .join(', ')
        .slice(0, 2000) || null,
  } as TimelineRow
  // Re-read: the timeline is rewritten whole, and the incident may have moved on meanwhile.
  const fresh = (await getIncident(payload, data.incidentId)) ?? incident
  if (fresh.status !== 'open') {
    await markStopped(payload, fresh)
    return { outcome: 'stopped', targets }
  }
  const updated = (await payload.update({
    collection: 'monitor-incidents',
    id: incident.id,
    depth: 0,
    overrideAccess: true,
    data: {
      timeline: [...(fresh.timeline ?? []), row],
      escalation: following
        ? {
            status: 'active',
            step: following.step,
            round: following.round,
            nextAt: new Date(now.getTime() + delayMs).toISOString(),
          }
        : { status: 'exhausted', step: data.step, round: data.round, nextAt: null },
    },
  })) as MonitorIncident
  if (following) {
    await enqueueStep({ ...data, step: following.step, round: following.round }, delayMs)
  }
  await publishIncident(payload, updated)
  log.info(
    { incidentId: incident.id, step: data.step, round: data.round, targets: targets.length },
    'escalation step paged',
  )
  return {
    outcome: 'paged',
    targets,
    next: following ? { ...following, delayMs } : null,
  }
}

/** `[api] [📟 Page] api is down and you are on call. Cause: … Acknowledge: <url>` */
export function buildPageMessage(
  monitorName: string,
  cause: string | null | undefined,
  locale: Locale = defaultLocale,
  url: string | null = null,
): string {
  const t = serverTranslator(locale)
  let text = t('notifications.messages.onCall.page', { monitor: monitorName })
  if (cause?.trim()) text += ` ${t('notifications.messages.onCall.cause', { cause: cause.trim() })}`
  if (url) text += ` ${t('notifications.messages.onCall.ack', { url })}`
  return `[${monitorName}] [${t('notifications.messages.onCall.label')}] ${text}`
}

export interface EscalationPageResult {
  outcome: 'sent' | 'skipped'
  reason?: string
}

/** Worker side of `escalation-page`: one email or channel message. Throws so BullMQ retries. */
export async function processEscalationPage(
  payload: Payload,
  data: EscalationPageJobData,
): Promise<EscalationPageResult> {
  const incident = await getIncident(payload, data.incidentId)
  if (!incident) return { outcome: 'skipped', reason: 'incident-not-found' }
  // Acknowledged or resolved since the step ran.
  if (incident.status !== 'open') return { outcome: 'skipped', reason: 'not-open' }
  const monitorId = relId(incident.monitor)
  const monitor =
    monitorId === null
      ? null
      : ((await payload
          .findByID({ collection: 'monitors', id: monitorId, depth: 0, overrideAccess: true })
          .catch(() => null)) as Monitor | null)
  if (!monitor) return { outcome: 'skipped', reason: 'monitor-not-found' }
  const { locale } = await getOrganizationI18n(payload, data.organizationId)
  const message = buildPageMessage(monitor.name, incident.cause, locale, ackLinkUrl(incident.id))

  if (data.target.type === 'channel') {
    const channel = (await payload
      .findByID({ collection: 'notifications', id: data.target.id, depth: 0, overrideAccess: true })
      .catch(() => null)) as Notification | null
    if (!channel?.active) return { outcome: 'skipped', reason: 'channel-unavailable' }
    await sendNotification(payload, channel, {
      message,
      monitor,
      heartbeat: null,
      event: 'down',
      locale,
    })
    log.info({ incidentId: incident.id, notificationId: channel.id }, 'paged a channel')
    return { outcome: 'sent' }
  }

  const user = (await payload
    .findByID({ collection: 'users', id: data.target.id, depth: 0, overrideAccess: true })
    .catch(() => null)) as User | null
  if (!user?.email || !getUserRole(user, data.organizationId)) {
    return { outcome: 'skipped', reason: 'member-not-found' }
  }
  const t = serverTranslator(locale)
  await payload.sendEmail({
    to: user.email,
    subject: t('notifications.messages.onCall.emailSubject', { monitor: monitor.name }),
    text: message,
  })
  log.info({ incidentId: incident.id, userId: user.id }, 'paged a member')
  return { outcome: 'sent' }
}

export interface StartEscalationWorkerOptions extends QueueFactoryOptions {
  concurrency?: number
}

/** The BullMQ worker of `marmot:escalations`. */
export function startEscalationWorker(
  payload: Payload,
  options: StartEscalationWorkerOptions = {},
) {
  const worker = createWorker<EscalationJobData, void, string>(
    QUEUE_NAMES.escalations,
    async (job: Job<EscalationJobData, void, string>) => {
      if (job.name === ESCALATION_STEP_JOB) {
        await processEscalationStep(payload, job.data as EscalationStepJobData)
      } else if (job.name === ESCALATION_PAGE_JOB) {
        await processEscalationPage(payload, job.data as EscalationPageJobData)
      }
    },
    {
      connection: options.connection,
      prefix: options.prefix,
      concurrency: options.concurrency ?? env.WORKER_CONCURRENCY,
    },
  )
  worker.on('failed', (job, err) => {
    log.error({ err, jobId: job?.id, name: job?.name }, 'escalation job failed')
  })
  worker.on('error', (err) => log.error({ err }, 'escalation worker error'))
  return worker
}
