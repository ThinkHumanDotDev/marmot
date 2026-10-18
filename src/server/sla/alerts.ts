/**
 * Error budget alerts (#274), through the same queue and providers as every other notification:
 *
 *   `sla-budget-check` (job scheduler on `marmot:maintenance`, every 15 minutes)
 *     ─▶ `checkSlaBudgets`: the current period of every target with thresholds and channels
 *     ─▶ BullMQ `marmot:notifications`, job `sla-budget-alert` per channel
 *     ─▶ notification worker ─▶ `processSlaBudgetAlertJob` ─▶ `sendNotification`
 *
 * A target alerts when its remaining error budget drops below one of its thresholds, at most once
 * per period and threshold (`budgetAlertState` records what was sent; a new period starts empty).
 * When several thresholds are crossed at once a single message names the lowest one.
 */
import type { JobsOptions, Queue } from 'bullmq'
import type { Payload } from 'payload'

import { env } from '@/env'
import { childLogger } from '@/lib/logger'
import { dueBudgetAlerts, isBudgetAlertState } from '@/lib/sla'
import type { Notification, SlaTarget } from '@/payload-types'
import { organizationFormatter, serverTranslator } from '@/server/i18n'
import { getNotificationsQueue, NOTIFICATION_JOB_OPTIONS } from '@/server/notifications/dispatch'
import { getChannelOrganization, sendNotification } from '@/server/notifications/send'
import { serverUrl } from '@/server/status-pages/urls'

import { targetStatuses } from './compute'

const log = childLogger('sla:alerts')

export const SLA_BUDGET_CHECK_JOB_NAME = 'sla-budget-check'
/** Every 15 minutes. */
export const SLA_BUDGET_CHECK_PATTERN = '*/15 * * * *'

export const SLA_BUDGET_ALERT_JOB = 'sla-budget-alert' as const

export const isSlaBudgetJobName = (name: string): name is typeof SLA_BUDGET_ALERT_JOB =>
  name === SLA_BUDGET_ALERT_JOB

export interface SlaBudgetAlertData {
  targetId: string
  notificationId: string
  /** `SlaPeriod.key`. */
  period: string
  /** The threshold crossed (percent of the budget). */
  threshold: number
  /** What was left when the check ran: 0..1 of the budget (below 0 when overspent). */
  remainingRatio: number
  budgetSeconds: number
  name: string
  /** The target, in percent. */
  target: number
}

export interface SlaBudgetJob {
  name: typeof SLA_BUDGET_ALERT_JOB
  data: SlaBudgetAlertData
  opts: JobsOptions & { jobId: string }
}

/** Where jobs go: BullMQ by default, a recorder in tests. */
export type SlaBudgetJobSink = (jobs: SlaBudgetJob[]) => Promise<void>

let sink: SlaBudgetJobSink | null = null

/** Replace the job sink (tests); `null` restores BullMQ. */
export function setSlaBudgetJobSink(next: SlaBudgetJobSink | null): void {
  sink = next
}

async function enqueue(jobs: SlaBudgetJob[]): Promise<void> {
  if (jobs.length === 0) return
  if (sink) return sink(jobs)
  if (env.MARMOT_DISABLE_ENGINE_HOOKS) {
    log.debug({ jobs: jobs.length }, 'engine hooks disabled; budget alert jobs not enqueued')
    return
  }
  const queue = getNotificationsQueue() as unknown as Queue<
    SlaBudgetAlertData,
    void,
    typeof SLA_BUDGET_ALERT_JOB
  >
  await queue.addBulk(jobs)
}

/** BullMQ custom job ids may not contain `:`. */
export const slaBudgetJobId = (
  targetId: string | number,
  notificationId: string | number,
  period: string,
  threshold: number,
) =>
  `sla-budget-${targetId}-${notificationId}-${period}-${threshold}`.replace(/[^A-Za-z0-9_-]/g, '-')

/**
 * Evaluates every target that has alert thresholds and channels, enqueues the alerts that became
 * due and records them on the target.
 */
export async function checkSlaBudgets(
  payload: Payload,
  now: Date = new Date(),
): Promise<{ checked: number; alerted: number }> {
  const { docs } = await payload.find({
    collection: 'sla-targets',
    depth: 0,
    limit: 0,
    pagination: false,
    overrideAccess: true,
  })
  const armed = (docs as SlaTarget[]).filter(
    (target) =>
      (target.budgetAlerts?.thresholds ?? []).length > 0 &&
      (target.budgetAlerts?.notifications ?? []).length > 0,
  )
  if (armed.length === 0) return { checked: 0, alerted: 0 }
  const byId = new Map(armed.map((target) => [String(target.id), target]))
  const statuses = await targetStatuses(payload, armed, now)

  let alerted = 0
  for (const status of statuses) {
    const doc = byId.get(status.id)
    if (!doc) continue
    const stored = isBudgetAlertState(doc.budgetAlertState) ? doc.budgetAlertState : null
    const { due, state } = dueBudgetAlerts(
      status.budgetAlerts.thresholds,
      status.attainment.remainingRatio,
      status.periodKey,
      stored,
    )
    if (due.length === 0) continue
    const threshold = Math.min(...due)
    await enqueue(
      status.budgetAlerts.notifications.map((notificationId) => ({
        name: SLA_BUDGET_ALERT_JOB,
        data: {
          targetId: status.id,
          notificationId,
          period: status.periodKey,
          threshold,
          remainingRatio: status.attainment.remainingRatio ?? 0,
          budgetSeconds: status.attainment.budgetSeconds,
          name: status.name,
          target: status.target,
        },
        opts: {
          ...NOTIFICATION_JOB_OPTIONS,
          jobId: slaBudgetJobId(status.id, notificationId, status.periodKey, threshold),
        },
      })),
    )
    await payload.update({
      collection: 'sla-targets',
      id: doc.id,
      data: { budgetAlertState: { ...state } },
      depth: 0,
      overrideAccess: true,
    })
    alerted += 1
    log.info({ targetId: status.id, threshold, period: status.periodKey }, 'SLA budget alert')
  }
  return { checked: armed.length, alerted }
}

/**
 * `[Checkout API] [📉 Error budget] Less than 25 % of the error budget left: 18 % of 43 minutes
 * (target 99.9 %). <url>` in the organization's language.
 */
export function buildBudgetAlertMessage(
  data: SlaBudgetAlertData,
  i18n: { locale: Parameters<typeof serverTranslator>[0]; timeZone: string },
  url: string | null,
): string {
  const t = serverTranslator(i18n.locale)
  const format = organizationFormatter({ locale: i18n.locale ?? 'en', timeZone: i18n.timeZone })
  const text =
    data.remainingRatio < 0
      ? t('notifications.messages.slaBudget.exhausted', {
          budget: format.number(data.budgetSeconds / 60, 'minutes'),
          target: format.number(data.target / 100, 'targetPercent'),
        })
      : t('notifications.messages.slaBudget.below', {
          threshold: format.number(data.threshold / 100, 'wholePercent'),
          remaining: format.number(data.remainingRatio, 'wholePercent'),
          budget: format.number(data.budgetSeconds / 60, 'minutes'),
          target: format.number(data.target / 100, 'targetPercent'),
        })
  const label = t('notifications.messages.slaBudget.label')
  return `[${data.name}] [${label}] ${text}${url ? ` ${url}` : ''}`
}

/** Worker side: load the channel and send. Throws so BullMQ retries. */
export async function processSlaBudgetAlertJob(
  payload: Payload,
  job: { data: SlaBudgetAlertData },
): Promise<'sent' | 'skipped'> {
  const channel = (await payload
    .findByID({
      collection: 'notifications',
      id: job.data.notificationId,
      depth: 0,
      overrideAccess: true,
    })
    .catch(() => null)) as Notification | null
  if (!channel || !channel.active) return 'skipped'
  const org = await getChannelOrganization(payload, channel)
  const url = org.organization ? `${serverUrl()}/${org.organization.slug}/sla` : null
  await sendNotification(payload, channel, {
    message: buildBudgetAlertMessage(job.data, org, url),
    monitor: null,
    heartbeat: null,
    channelOrganization: org,
  })
  log.info(
    { targetId: job.data.targetId, notificationId: job.data.notificationId },
    'SLA budget alert sent',
  )
  return 'sent'
}

/** Upsert the `sla-budget-check` scheduler. Idempotent; called on every worker boot. */
export async function scheduleSlaBudgetCheckJob(queue: Queue): Promise<void> {
  await queue.upsertJobScheduler(
    SLA_BUDGET_CHECK_JOB_NAME,
    { pattern: SLA_BUDGET_CHECK_PATTERN, tz: 'UTC' },
    { name: SLA_BUDGET_CHECK_JOB_NAME, opts: { removeOnComplete: 10, removeOnFail: 50 } },
  )
}
