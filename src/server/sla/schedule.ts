/**
 * Scheduled SLA reports (#156), on the existing BullMQ queues:
 *
 * - `sla-reports-due` (job scheduler on `marmot:maintenance`, hourly at :40, after the daily
 *   uptime snapshot at 00:20 UTC): for every report with a schedule whose latest complete period
 *   (previous week or previous month in the organization's time zone, starting on its first day
 *   of the week, `previousSchedulePeriod`) has not been sent yet, enqueue one `sla-report-send`
 *   job.
 * - `sla-report-send` (on `marmot:notifications`, processed by the notification worker; job id
 *   `sla-report-<report>-<period>` dedupes, three attempts with exponential backoff): builds the
 *   report, renders the CSV and the PDF and emails them to each recipient through the Payload
 *   email adapter, then records `lastSentPeriod` / `lastSentAt` on the report. After the last
 *   failed attempt the period is recorded with `lastError`, so a broken mailer does not retry the
 *   same period every hour.
 *
 * So a monthly report goes out within the first hour of the 1st in the organization's time zone
 * (#274), a weekly one on the first day of its week. "Send now" (`sendSlaReport`) mails a report
 * at once without touching the schedule's bookkeeping. Tests replace the job sink with
 * `setSlaJobSink` to run jobs inline.
 */
import type { Job, JobsOptions, Queue } from 'bullmq'
import type { Payload } from 'payload'

import { env } from '@/env'
import { childLogger } from '@/lib/logger'
import {
  isSlaSchedule,
  previousSchedulePeriod,
  slaReportCsv,
  slaReportFileStem,
  UTC_ZONE,
  type SlaPeriod,
} from '@/lib/sla'
import type { SlaReport } from '@/payload-types'
import { getOrganizationI18n } from '@/server/i18n'
import { relationId } from '@/server/maintenance/serialize'
import { getNotificationsQueue } from '@/server/notifications/dispatch'

import { buildSlaReport } from './compute'
import { renderSlaReportEmail, renderSlaReportPdf } from './render'
import { loadSlaZones } from './zone'

const log = childLogger('sla:schedule')

export const SLA_REPORTS_DUE_JOB_NAME = 'sla-reports-due'
/** Hourly at :40 UTC: within the first hour of a new period in any time zone. */
export const SLA_REPORTS_DUE_PATTERN = '40 * * * *'

export const SLA_REPORT_SEND_JOB = 'sla-report-send' as const
export const SLA_REPORT_SEND_ATTEMPTS = 3

export const isSlaJobName = (name: string): name is typeof SLA_REPORT_SEND_JOB =>
  name === SLA_REPORT_SEND_JOB

export interface SlaReportSendData {
  reportId: string
  /** `SlaPeriod.key` */
  period: string
  from: number
  to: number
}

export interface SlaJob {
  name: typeof SLA_REPORT_SEND_JOB
  data: SlaReportSendData
  opts: JobsOptions & { jobId: string }
}

/** BullMQ custom job ids may not contain `:`. */
export const slaReportJobId = (reportId: string | number, periodKey: string) =>
  `sla-report-${reportId}-${periodKey.replace(/[^A-Za-z0-9_-]/g, '-')}`

export const slaReportSendJob = (reportId: string | number, period: SlaPeriod): SlaJob => ({
  name: SLA_REPORT_SEND_JOB,
  data: { reportId: String(reportId), period: period.key, from: period.from, to: period.to },
  opts: {
    jobId: slaReportJobId(reportId, period.key),
    attempts: SLA_REPORT_SEND_ATTEMPTS,
    backoff: { type: 'exponential', delay: 60_000 },
    removeOnComplete: { age: 7 * 24 * 3600 },
    removeOnFail: { age: 30 * 24 * 3600 },
  },
})

/** Where jobs go: BullMQ by default, an inline runner in tests. */
export type SlaJobSink = (jobs: SlaJob[]) => Promise<void>

let sink: SlaJobSink | null = null

/** Replace the job sink (tests); `null` restores BullMQ. */
export function setSlaJobSink(next: SlaJobSink | null): void {
  sink = next
}

async function enqueue(jobs: SlaJob[]): Promise<void> {
  if (jobs.length === 0) return
  if (sink) return sink(jobs)
  if (env.MARMOT_DISABLE_ENGINE_HOOKS) {
    log.debug({ jobs: jobs.length }, 'engine hooks disabled; SLA report jobs not enqueued')
    return
  }
  const queue = getNotificationsQueue() as unknown as Queue<
    SlaReportSendData,
    void,
    typeof SLA_REPORT_SEND_JOB
  >
  await queue.addBulk(jobs)
}

/** Enqueue the reports whose latest complete period is due. */
export async function enqueueDueSlaReports(
  payload: Payload,
  now: Date = new Date(),
): Promise<{ checked: number; enqueued: number }> {
  const { docs } = await payload.find({
    collection: 'sla-reports',
    where: { schedule: { in: ['weekly', 'monthly'] } },
    depth: 0,
    limit: 0,
    pagination: false,
    overrideAccess: true,
    select: { organization: true, schedule: true, lastSentPeriod: true, recipients: true },
  })
  const zones = await loadSlaZones(
    payload,
    (docs as SlaReport[]).map((report) => relationId(report.organization)),
  )
  const jobs: SlaJob[] = []
  for (const report of docs as SlaReport[]) {
    if (!isSlaSchedule(report.schedule) || (report.recipients ?? []).length === 0) continue
    const zone = zones.get(String(relationId(report.organization))) ?? UTC_ZONE
    const period = previousSchedulePeriod(report.schedule, now, zone)
    if (!period || report.lastSentPeriod === period.key) continue
    jobs.push(slaReportSendJob(report.id, period))
  }
  await enqueue(jobs)
  if (jobs.length > 0) log.info({ enqueued: jobs.length }, 'SLA reports due')
  return { checked: docs.length, enqueued: jobs.length }
}

/**
 * Builds `report` over `period` and emails it, with the CSV and PDF attached, to each of
 * `recipients` (one message per recipient, so they do not see each other's addresses).
 */
export async function sendSlaReport(
  payload: Payload,
  report: SlaReport,
  period: SlaPeriod,
  recipients: readonly string[],
  now: Date = new Date(),
): Promise<void> {
  const data = await buildSlaReport(payload, report, period, now)
  const orgId = relationId(report.organization)
  const [i18n, org] = await Promise.all([
    getOrganizationI18n(payload, orgId),
    orgId === null
      ? null
      : payload
          .findByID({
            collection: 'organizations',
            id: orgId,
            depth: 0,
            overrideAccess: true,
            select: { name: true },
          })
          .catch(() => null),
  ])
  const email = renderSlaReportEmail(data, org?.name ?? '', i18n)
  const stem = slaReportFileStem(data)
  const attachments = [
    { filename: `${stem}.csv`, content: slaReportCsv(data), contentType: 'text/csv' },
    {
      filename: `${stem}.pdf`,
      content: renderSlaReportPdf(data, i18n),
      contentType: 'application/pdf',
    },
  ]
  for (const to of recipients) {
    await payload.sendEmail({ to, ...email, attachments })
  }
}

async function recordOutcome(
  payload: Payload,
  report: SlaReport,
  data: Partial<Pick<SlaReport, 'lastSentPeriod' | 'lastSentAt' | 'lastError'>>,
) {
  await payload.update({
    collection: 'sla-reports',
    id: report.id,
    data,
    depth: 0,
    overrideAccess: true,
  })
}

/**
 * Sends one period of one report. Idempotent: a period already recorded on the report is skipped.
 */
export async function processSlaReportSendJob(
  payload: Payload,
  job: Pick<Job<SlaReportSendData>, 'data' | 'attemptsMade'> & { opts?: { attempts?: number } },
  now: Date = new Date(),
): Promise<{ sent: number } | null> {
  const { reportId, period: key, from, to } = job.data
  const report = (await payload
    .findByID({
      collection: 'sla-reports',
      id: reportId,
      depth: 0,
      overrideAccess: true,
    })
    .catch(() => null)) as SlaReport | null
  if (!report || report.lastSentPeriod === key) return null
  const recipients = (report.recipients ?? []).map((row) => row.email).filter(Boolean)
  if (recipients.length === 0) return null

  try {
    await sendSlaReport(payload, report, { from, to, key }, recipients, now)
    await recordOutcome(payload, report, {
      lastSentPeriod: key,
      lastSentAt: now.toISOString(),
      lastError: null,
    })
    log.info({ reportId, period: key, recipients: recipients.length }, 'SLA report sent')
    return { sent: recipients.length }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const attempts = job.opts?.attempts ?? SLA_REPORT_SEND_ATTEMPTS
    const final = job.attemptsMade + 1 >= attempts
    log.error({ err, reportId, period: key, final }, 'SLA report failed')
    await recordOutcome(payload, report, {
      lastError: message.slice(0, 500),
      ...(final ? { lastSentPeriod: key } : {}),
    }).catch(() => undefined)
    throw err
  }
}

/** Upsert the hourly `sla-reports-due` scheduler. Idempotent; called on every worker boot. */
export async function scheduleSlaReportsJob(queue: Queue): Promise<void> {
  await queue.upsertJobScheduler(
    SLA_REPORTS_DUE_JOB_NAME,
    { pattern: SLA_REPORTS_DUE_PATTERN, tz: 'UTC' },
    { name: SLA_REPORTS_DUE_JOB_NAME, opts: { removeOnComplete: 10, removeOnFail: 50 } },
  )
}
