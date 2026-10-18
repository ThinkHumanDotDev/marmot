/**
 * SLA targets, reports, share links and scheduled reports (#156).
 *
 * Fixture: one monitor observed over the whole previous calendar month (UTC), DOWN for 20 minutes
 * on day 3 and in maintenance for two hours on day 5; 20 failed and 120 maintenance checks.
 */
import { getPayload, type Payload, type RequiredDataFromCollectionSlug } from 'payload'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import config from '@payload-config'
import { GET as reportRoute } from '@/app/api/orgs/[orgId]/sla/reports/[id]/route'
import { POST as sendRoute } from '@/app/api/orgs/[orgId]/sla/reports/[id]/send/route'
import { DELETE as revokeRoute } from '@/app/api/orgs/[orgId]/sla/reports/[id]/shares/[shareId]/route'
import {
  GET as sharesListRoute,
  POST as sharesRoute,
} from '@/app/api/orgs/[orgId]/sla/reports/[id]/shares/route'
import { GET as targetsRoute } from '@/app/api/orgs/[orgId]/sla/targets/route'
import { GET as publicRoute } from '@/app/api/sla/[token]/route'
import { periodDates, periodFromDates, previousSchedulePeriod, type SlaReportData } from '@/lib/sla'
import type {
  Monitor,
  Notification,
  Organization,
  SlaReport,
  SlaTarget,
  StatusPage,
  User,
} from '@/payload-types'
import {
  checkSlaBudgets,
  processSlaBudgetAlertJob,
  setSlaBudgetJobSink,
  type SlaBudgetJob,
} from '@/server/sla/alerts'
import type { TargetStatus } from '@/server/sla/compute'
import { buildSlaReport, targetStatuses } from '@/server/sla/compute'
import {
  enqueueDueSlaReports,
  processSlaReportSendJob,
  setSlaJobSink,
  slaReportJobId,
  type SlaJob,
} from '@/server/sla/schedule'

let payload: Payload

const run = Date.now().toString(36)
const email = (name: string) => `${name}+sla-${run}@marmot.test`
const PASSWORD = 'password-123'
const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

const MONITOR_DEFAULTS = {
  type: 'manual' as const,
  active: true,
  interval: 60,
  retryInterval: 60,
  maxRetries: 0,
  resendInterval: 0,
  timeout: 48,
}

const now = new Date()
const month = previousSchedulePeriod('monthly', now)!
const range = periodDates(month)
const monthSeconds = (month.to - month.from) / 1000
const days = Math.round(monthSeconds / 86_400)
const at = (day: number, ms = 0) => new Date(month.from + (day - 1) * DAY + ms).toISOString()

let owner: User
let viewer: User
let outsider: User
let org: Organization
let otherOrg: Organization
let monitor: Monitor
let foreignMonitor: Monitor
let durationTarget: SlaTarget
let checksTarget: SlaTarget
let report: SlaReport
let otherReport: SlaReport
const tokens: Record<string, string> = {}

type Handler = (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>

const call = (
  handler: unknown,
  path: string,
  params: Record<string, string>,
  token?: string,
  init: RequestInit = {},
): Promise<Response> =>
  (handler as Handler)(
    new Request(`http://localhost${path}`, {
      ...init,
      headers: {
        ...(token ? { authorization: `JWT ${token}` } : {}),
        ...(init.body ? { 'content-type': 'application/json' } : {}),
      },
    }),
    { params: Promise.resolve(params) },
  )

const asUser = (user: User) => ({ ...user, collection: 'users' as const })

describe('SLA targets and reports', () => {
  beforeAll(async () => {
    payload = await getPayload({ config })
    const create = (name: string) =>
      payload.create({
        collection: 'users',
        data: { email: email(name), password: PASSWORD, name },
      })
    owner = await create('owner')
    viewer = await create('viewer')
    outsider = await create('outsider')
    org = await payload.create({
      collection: 'organizations',
      data: { name: 'SLA Acme', slug: `sla-acme-${run}` },
      user: asUser(owner),
      overrideAccess: false,
    })
    otherOrg = await payload.create({
      collection: 'organizations',
      data: { name: 'SLA Other', slug: `sla-other-${run}` },
      user: asUser(outsider),
      overrideAccess: false,
    })
    await payload.update({
      collection: 'users',
      id: viewer.id,
      data: { organizations: [{ organization: org.id, role: 'viewer' }] },
    })
    owner = await payload.findByID({ collection: 'users', id: owner.id })
    viewer = await payload.findByID({ collection: 'users', id: viewer.id })
    outsider = await payload.findByID({ collection: 'users', id: outsider.id })

    monitor = await payload.create({
      collection: 'monitors',
      data: {
        ...MONITOR_DEFAULTS,
        name: 'Checkout API',
        organization: org.id,
        status: { lastStatus: 'up', lastCheckAt: now.toISOString() },
      },
    })
    foreignMonitor = await payload.create({
      collection: 'monitors',
      data: { ...MONITOR_DEFAULTS, name: 'Foreign', organization: otherOrg.id },
    })

    // One stat-daily row per day: 1440 checks, 20 failed on day 3, 120 in maintenance on day 5.
    for (let day = 1; day <= days; day++) {
      await payload.create({
        collection: 'stat-daily',
        data: {
          monitor: monitor.id,
          organization: org.id,
          timestamp: (month.from + (day - 1) * DAY) / 1000,
          up: day === 3 ? 1420 : 1440,
          down: day === 3 ? 20 : 0,
          extras: day === 5 ? { maintenance: 120 } : {},
        },
      })
    }
    for (const [time, status] of [
      [new Date(month.from - DAY).toISOString(), 'up'],
      [at(3, 10 * HOUR), 'down'],
      [at(3, 10 * HOUR + 20 * MIN), 'up'],
      [at(5), 'maintenance'],
      [at(5, 2 * HOUR), 'up'],
    ] as const) {
      await payload.create({
        collection: 'heartbeats',
        data: { monitor: monitor.id, organization: org.id, status, time, important: true },
      })
    }
    // The incident of the outage (resolved after 20 minutes) and one from before the month.
    for (const [startedAt, resolvedAt] of [
      [at(3, 10 * HOUR), at(3, 10 * HOUR + 20 * MIN)],
      [new Date(month.from - 5 * DAY).toISOString(), new Date(month.from - 4 * DAY).toISOString()],
    ]) {
      await payload.create({
        collection: 'monitor-incidents',
        data: {
          organization: org.id,
          monitor: monitor.id,
          status: 'resolved',
          cause: 'Connection refused',
          startedAt,
          resolvedAt,
        },
        overrideAccess: true,
      })
    }

    const login = async (user: User) =>
      (
        await payload.login({
          collection: 'users',
          data: { email: user.email, password: PASSWORD },
        })
      ).token as string
    tokens.owner = await login(owner)
    tokens.viewer = await login(viewer)
    tokens.outsider = await login(outsider)
  })

  afterAll(async () => {
    setSlaJobSink(null)
    for (const target of [org, otherOrg]) {
      if (!target?.id) continue
      const where = { organization: { equals: target.id } }
      await payload.delete({ collection: 'heartbeats', where })
      await payload.delete({ collection: 'stat-daily', where })
      await payload.delete({ collection: 'stat-hourly', where })
      await payload.delete({ collection: 'sla-targets', where })
      await payload.delete({ collection: 'notifications', where })
      await payload.delete({ collection: 'monitor-incidents', where })
      await payload.delete({ collection: 'monitors', where })
      await payload.delete({ collection: 'organizations', id: target.id })
    }
    await payload.delete({ collection: 'users', where: { email: { like: `+sla-${run}@` } } })
  })

  describe('targets', () => {
    it('lets admins create targets, refusing monitors of other organizations', async () => {
      durationTarget = (await payload.create({
        collection: 'sla-targets',
        data: {
          organization: org.id,
          monitor: monitor.id,
          target: 99.9,
          period: 'month',
          calculation: 'duration',
          excludeMaintenance: false,
        },
        user: asUser(owner),
        overrideAccess: false,
      })) as SlaTarget
      checksTarget = (await payload.create({
        collection: 'sla-targets',
        data: {
          organization: org.id,
          monitor: monitor.id,
          target: 99.9,
          period: 'month',
          calculation: 'checks',
          excludeMaintenance: true,
        },
        user: asUser(owner),
        overrideAccess: false,
      })) as SlaTarget

      await expect(
        payload.create({
          collection: 'sla-targets',
          data: { organization: org.id, monitor: foreignMonitor.id, target: 99.9 },
          user: asUser(owner),
          overrideAccess: false,
        } as never),
      ).rejects.toThrow()
    })

    it('does not let viewers or other organizations write targets', async () => {
      await expect(
        payload.create({
          collection: 'sla-targets',
          data: { organization: org.id, monitor: monitor.id, target: 99 },
          user: asUser(viewer),
          overrideAccess: false,
        } as never),
      ).rejects.toThrow()
      await expect(
        payload.update({
          collection: 'sla-targets',
          id: durationTarget.id,
          data: { target: 90 },
          user: asUser(outsider),
          overrideAccess: false,
        }),
      ).rejects.toThrow()
      const { docs } = await payload.find({
        collection: 'sla-targets',
        user: asUser(outsider),
        overrideAccess: false,
      })
      expect(docs.map((d) => String(d.id))).not.toContain(String(durationTarget.id))
    })

    it('computes attainment and budget from the rollups (duration, maintenance counted as up)', async () => {
      const [status] = await targetStatuses(payload, [durationTarget], new Date(month.to - 1))
      const expected = 1 - 1200 / monthSeconds
      expect(status.attainment.uptime).toBeCloseTo(expected, 9)
      expect(status.attainment.budgetSeconds).toBeCloseTo(0.001 * monthSeconds, 3)
      expect(status.attainment.remainingSeconds).toBeCloseTo(0.001 * monthSeconds - 1200, 3)
      expect(status.attainment.met).toBe(true)
      expect(status.health).toBe('met')
      expect(status.incidents.map((i) => i.cause)).toEqual(['Connection refused'])
    })

    it('excludes maintenance from checks-based attainment', async () => {
      const [status] = await targetStatuses(payload, [checksTarget], new Date(month.to - 1))
      const up = 1440 * days - 20 - 120
      expect(status.attainment.uptime).toBeCloseTo(up / (up + 20), 9)
      // The two hours of maintenance leave the budget.
      expect(status.attainment.budgetSeconds).toBeCloseTo(0.001 * (monthSeconds - 7200), 3)
    })

    it('serves target statuses to viewers, not to other organizations', async () => {
      const ok = await call(
        targetsRoute,
        `/api/orgs/${org.id}/sla/targets`,
        { orgId: String(org.id) },
        tokens.viewer,
      )
      expect(ok.status).toBe(200)
      const body = (await ok.json()) as { docs: TargetStatus[] }
      expect(body.docs.map((d) => d.id).sort()).toEqual(
        [String(durationTarget.id), String(checksTarget.id)].sort(),
      )
      const denied = await call(
        targetsRoute,
        `/api/orgs/${org.id}/sla/targets`,
        { orgId: String(org.id) },
        tokens.outsider,
      )
      expect(denied.status).toBe(403)
    })
  })

  describe('reports', () => {
    it('builds per-target uptime, downtime, incidents and MTTR over a range', async () => {
      report = (await payload.create({
        collection: 'sla-reports',
        data: {
          organization: org.id,
          name: 'Customer SLA',
          targets: [durationTarget.id, checksTarget.id],
          schedule: 'none',
        },
        user: asUser(owner),
        overrideAccess: false,
      })) as SlaReport
      const data = await buildSlaReport(payload, report, month, now)
      expect(data.from).toBe(range.from)
      expect(data.to).toBe(range.to)
      const [duration, checks] = data.rows
      expect(duration.name).toBe('Checkout API')
      expect(duration.uptime).toBeCloseTo(1 - 1200 / monthSeconds, 9)
      expect(duration.downtimeSeconds).toBe(1200)
      expect(duration.incidents).toBe(1)
      expect(duration.mttrSeconds).toBe(1200)
      expect(duration.met).toBe(true)
      expect(checks.met).toBe(true)
    })

    it('refuses targets of other organizations in a report', async () => {
      const foreign = await payload.create({
        collection: 'sla-targets',
        data: { organization: otherOrg.id, monitor: foreignMonitor.id, target: 99 },
        overrideAccess: true,
      } as never)
      otherReport = (await payload.create({
        collection: 'sla-reports',
        data: { organization: otherOrg.id, name: 'Other', targets: [foreign.id] },
        overrideAccess: true,
      } as never)) as SlaReport
      await expect(
        payload.update({
          collection: 'sla-reports',
          id: report.id,
          data: { targets: [durationTarget.id, foreign.id] },
          user: asUser(owner),
          overrideAccess: false,
        }),
      ).rejects.toThrow()
    })

    it('exports JSON, CSV and PDF to members only', async () => {
      const path = `/api/orgs/${org.id}/sla/reports/${report.id}`
      const params = { orgId: String(org.id), id: String(report.id) }
      const query = `?from=${range.from}&to=${range.to}`
      const json = await call(reportRoute, `${path}${query}`, params, tokens.viewer)
      expect(json.status).toBe(200)
      expect(((await json.json()) as SlaReportData).rows).toHaveLength(2)

      const csv = await call(reportRoute, `${path}${query}&format=csv`, params, tokens.viewer)
      expect(csv.headers.get('content-type')).toContain('text/csv')
      expect((await csv.text()).split('\r\n')[1]).toMatch(/^Checkout API,99\.9,99\.95/)

      const pdf = await call(reportRoute, `${path}${query}&format=pdf`, params, tokens.viewer)
      expect(pdf.headers.get('content-type')).toBe('application/pdf')
      const bytes = Buffer.from(await pdf.arrayBuffer()).toString('latin1')
      expect(bytes.startsWith('%PDF-1.4')).toBe(true)
      expect(bytes).toContain('(Checkout API)')

      expect((await call(reportRoute, `${path}${query}`, params, tokens.outsider)).status).toBe(403)
      // Another organization's report is not found through this organization's URL.
      const foreign = await call(
        reportRoute,
        `/api/orgs/${org.id}/sla/reports/${otherReport.id}`,
        { orgId: String(org.id), id: String(otherReport.id) },
        tokens.owner,
      )
      expect(foreign.status).toBe(404)
      expect(
        (await call(reportRoute, `${path}?from=2026-02-31&to=2026-03-01`, params, tokens.owner))
          .status,
      ).toBe(400)
    })
  })

  describe('share links', () => {
    const sharesPath = () => `/api/orgs/${org.id}/sla/reports/${report.id}/shares`
    const params = () => ({ orgId: String(org.id), id: String(report.id) })
    let token: string
    let shareId: string

    it('lets admins create a link, showing the token once and storing only its hash', async () => {
      const body = JSON.stringify(range)
      const denied = await call(sharesRoute, sharesPath(), params(), tokens.viewer, {
        method: 'POST',
        body,
      })
      expect(denied.status).toBe(403)

      const res = await call(sharesRoute, sharesPath(), params(), tokens.owner, {
        method: 'POST',
        body,
      })
      expect(res.status).toBe(201)
      const created = (await res.json()) as { url: string; token: string; doc: { id: string } }
      token = created.token
      shareId = created.doc.id
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
      expect(created.url.endsWith(`/sla/${token}`)).toBe(true)

      const stored = await payload.findByID({
        collection: 'sla-report-shares',
        id: shareId,
        user: asUser(owner),
        overrideAccess: false,
      })
      expect(stored).not.toHaveProperty('tokenHash')
      const raw = await payload.findByID({ collection: 'sla-report-shares', id: shareId })
      expect(raw.tokenHash).not.toContain(token)

      // Shares cannot be created through the collection API (no token hash can be set).
      await expect(
        payload.create({
          collection: 'sla-report-shares',
          data: {
            organization: org.id,
            report: report.id,
            tokenHash: 'chosen',
            fromDate: range.from,
            toDate: range.to,
          },
          user: asUser(owner),
          overrideAccess: false,
        }),
      ).rejects.toThrow()

      const list = await call(sharesListRoute, sharesPath(), params(), tokens.owner)
      expect(((await list.json()) as { docs: { id: string }[] }).docs.map((d) => d.id)).toEqual([
        shareId,
      ])
    })

    it('exposes only that report over its range to anyone with the link', async () => {
      const res = await call(publicRoute, `/api/sla/${token}`, { token })
      expect(res.status).toBe(200)
      const data = (await res.json()) as SlaReportData
      expect(Object.keys(data).sort()).toEqual([
        'from',
        'generatedAt',
        'name',
        'rows',
        'timeZone',
        'to',
      ])
      expect(data.name).toBe('Customer SLA')
      expect([data.from, data.to]).toEqual([range.from, range.to])
      expect(data.rows.map((r) => r.name)).toEqual(['Checkout API', 'Checkout API'])
      const csv = await call(publicRoute, `/api/sla/${token}?format=csv`, { token })
      expect(csv.status).toBe(200)

      for (const guess of [
        'x'.repeat(43),
        'short',
        `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`,
      ]) {
        expect((await call(publicRoute, `/api/sla/${guess}`, { token: guess })).status).toBe(404)
      }
    })

    it('revokes links for good', async () => {
      const foreign = await call(
        revokeRoute,
        `${sharesPath()}/${shareId}`,
        { ...params(), shareId },
        tokens.outsider,
        { method: 'DELETE' },
      )
      expect(foreign.status).toBe(403)
      const viewerRes = await call(
        revokeRoute,
        `${sharesPath()}/${shareId}`,
        { ...params(), shareId },
        tokens.viewer,
        { method: 'DELETE' },
      )
      expect(viewerRes.status).toBe(403)

      const res = await call(
        revokeRoute,
        `${sharesPath()}/${shareId}`,
        { ...params(), shareId },
        tokens.owner,
        { method: 'DELETE' },
      )
      expect(res.status).toBe(200)
      expect(
        ((await res.json()) as { doc: { revokedAt: string | null } }).doc.revokedAt,
      ).toBeTruthy()
      expect((await call(publicRoute, `/api/sla/${token}`, { token })).status).toBe(404)

      // Clearing `revokedAt` through the API does not bring the link back.
      await payload.update({
        collection: 'sla-report-shares',
        id: shareId,
        data: { revokedAt: null },
        user: asUser(owner),
        overrideAccess: false,
      })
      expect((await call(publicRoute, `/api/sla/${token}`, { token })).status).toBe(404)
    })

    it('stops working when the report is deleted', async () => {
      const res = await call(sharesRoute, sharesPath(), params(), tokens.owner, {
        method: 'POST',
        body: JSON.stringify(range),
      })
      const { token: second } = (await res.json()) as { token: string }
      const temp = (await payload.create({
        collection: 'sla-reports',
        data: { organization: org.id, name: 'Temporary', targets: [durationTarget.id] },
        overrideAccess: true,
      } as never)) as SlaReport
      const tempRes = await call(
        sharesRoute,
        `/api/orgs/${org.id}/sla/reports/${temp.id}/shares`,
        { orgId: String(org.id), id: String(temp.id) },
        tokens.owner,
        { method: 'POST', body: JSON.stringify(range) },
      )
      const { token: tempToken } = (await tempRes.json()) as { token: string }
      expect((await call(publicRoute, `/api/sla/${tempToken}`, { token: tempToken })).status).toBe(
        200,
      )
      await payload.delete({
        collection: 'sla-reports',
        id: temp.id,
        user: asUser(owner),
        overrideAccess: false,
      })
      expect((await call(publicRoute, `/api/sla/${tempToken}`, { token: tempToken })).status).toBe(
        404,
      )
      // The other report's link is unaffected.
      expect((await call(publicRoute, `/api/sla/${second}`, { token: second })).status).toBe(200)
    })
  })

  describe('scheduled reports', () => {
    const firstOfMonth = new Date(month.to + 40 * MIN) // the 1st, 00:40 UTC, after the month

    it('starts a new schedule with the next period to complete', async () => {
      report = (await payload.update({
        collection: 'sla-reports',
        id: report.id,
        data: {
          schedule: 'monthly',
          recipients: [{ email: 'a@example.com' }, { email: 'b@example.com' }],
        },
        user: asUser(owner),
        overrideAccess: false,
      })) as SlaReport
      expect(report.lastSentPeriod).toBe(previousSchedulePeriod('monthly', new Date())?.key)

      const jobs: SlaJob[] = []
      setSlaJobSink(async (batch) => void jobs.push(...batch))
      await enqueueDueSlaReports(payload, new Date())
      expect(jobs.filter((job) => job.data.reportId === String(report.id))).toEqual([])
    })

    it('requires recipients for a schedule', async () => {
      await expect(
        payload.update({
          collection: 'sla-reports',
          id: report.id,
          data: { recipients: [] },
          user: asUser(owner),
          overrideAccess: false,
        }),
      ).rejects.toThrow()
    })

    it('emails the finished month on the 1st with the CSV and PDF attached, once', async () => {
      // As if the last report went out a month earlier.
      await payload.update({
        collection: 'sla-reports',
        id: report.id,
        data: { lastSentPeriod: 'earlier' },
        overrideAccess: true,
      })
      const jobs: SlaJob[] = []
      setSlaJobSink(async (batch) => void jobs.push(...batch))
      await enqueueDueSlaReports(payload, firstOfMonth)
      const mine = jobs.filter((job) => job.data.reportId === String(report.id))
      expect(mine).toHaveLength(1)
      expect(mine[0].data.period).toBe(month.key)
      expect(mine[0].opts.jobId).toBe(slaReportJobId(report.id, month.key))
      expect(mine[0].opts.jobId).not.toContain(':')

      const sendEmail = vi.spyOn(payload, 'sendEmail').mockResolvedValue(undefined as never)
      try {
        const job = { data: mine[0].data, attemptsMade: 0, opts: mine[0].opts }
        expect(await processSlaReportSendJob(payload, job, firstOfMonth)).toEqual({ sent: 2 })
        expect(sendEmail.mock.calls.map(([message]) => message.to)).toEqual([
          'a@example.com',
          'b@example.com',
        ])
        const [message] = sendEmail.mock.calls[0]
        expect(message.subject).toContain('Customer SLA')
        const attachments = (message as { attachments: { filename: string; content: unknown }[] })
          .attachments
        expect(attachments.map((a) => a.filename)).toEqual([
          `customer-sla-sla-${range.from}-${range.to}.csv`,
          `customer-sla-sla-${range.from}-${range.to}.pdf`,
        ])
        expect(String(attachments[0].content)).toContain('Checkout API')
        expect(Buffer.isBuffer(attachments[1].content)).toBe(true)

        const after = await payload.findByID({ collection: 'sla-reports', id: report.id })
        expect(after.lastSentPeriod).toBe(month.key)
        expect(after.lastSentAt).toBeTruthy()

        // Not due again, and a duplicate job is a no-op.
        jobs.length = 0
        await enqueueDueSlaReports(payload, new Date(firstOfMonth.getTime() + HOUR))
        expect(jobs.filter((job) => job.data.reportId === String(report.id))).toEqual([])
        expect(await processSlaReportSendJob(payload, job, firstOfMonth)).toBeNull()
        expect(sendEmail).toHaveBeenCalledTimes(2)
      } finally {
        sendEmail.mockRestore()
      }
    })

    it('records the failure and gives the period up after the last attempt', async () => {
      await payload.update({
        collection: 'sla-reports',
        id: report.id,
        data: { lastSentPeriod: 'earlier' },
        overrideAccess: true,
      })
      const sendEmail = vi.spyOn(payload, 'sendEmail').mockRejectedValue(new Error('SMTP down'))
      const data = {
        reportId: String(report.id),
        period: month.key,
        from: month.from,
        to: month.to,
      }
      try {
        await expect(
          processSlaReportSendJob(payload, { data, attemptsMade: 0, opts: { attempts: 3 } }),
        ).rejects.toThrow('SMTP down')
        let doc = await payload.findByID({ collection: 'sla-reports', id: report.id })
        expect(doc.lastError).toBe('SMTP down')
        expect(doc.lastSentPeriod).toBe('earlier')

        await expect(
          processSlaReportSendJob(payload, { data, attemptsMade: 2, opts: { attempts: 3 } }),
        ).rejects.toThrow('SMTP down')
        doc = await payload.findByID({ collection: 'sla-reports', id: report.id })
        expect(doc.lastSentPeriod).toBe(month.key)
      } finally {
        sendEmail.mockRestore()
      }
    })
  })

  describe('business hours (#274)', () => {
    const everyDay = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const
    const create = (data: Record<string, unknown>) =>
      payload.create({
        collection: 'sla-targets',
        data: {
          organization: org.id,
          monitor: monitor.id,
          target: 99.9,
          period: 'month',
          excludeMaintenance: false,
          ...data,
        },
        user: asUser(owner),
        overrideAccess: false,
      } as never) as Promise<SlaTarget>
    const hours = (start: string, end: string) => ({
      enabled: true,
      days: [...everyDay],
      start,
      end,
      holidays: [],
    })

    beforeAll(async () => {
      // Hourly buckets of day 3: 60 checks an hour, 20 of them failed at 10:00.
      for (let hour = 0; hour < 24; hour++) {
        await payload.create({
          collection: 'stat-hourly',
          data: {
            monitor: monitor.id,
            organization: org.id,
            timestamp: (month.from + 2 * DAY + hour * HOUR) / 1000,
            up: hour === 10 ? 40 : 60,
            down: hour === 10 ? 20 : 0,
          },
        })
      }
    })

    it('counts downtime and budget only inside the calendar (duration)', async () => {
      const inside = await create({
        calculation: 'duration',
        businessHours: hours('09:00', '17:00'),
      })
      const outside = await create({
        calculation: 'duration',
        businessHours: hours('12:00', '17:00'),
      })
      const [a, b] = await targetStatuses(payload, [inside, outside], new Date(month.to - 1))
      const counted = days * 8 * 3600
      expect(a.businessHours?.start).toBe('09:00')
      expect(a.attainment.budgetSeconds).toBeCloseTo(0.001 * counted, 3)
      expect(a.attainment.uptime).toBeCloseTo(1 - 1200 / counted, 9)
      expect(a.attainment.remainingSeconds).toBeCloseTo(0.001 * counted - 1200, 3)
      // The outage at 10:00 is outside 12:00–17:00.
      expect(b.attainment.uptime).toBe(1)
      expect(b.attainment.budgetSeconds).toBeCloseTo(0.001 * days * 5 * 3600, 3)
    })

    it('reads the checks of the counted hours from the hourly buckets', async () => {
      const afternoon = await create({
        calculation: 'checks',
        businessHours: hours('12:00', '17:00'),
      })
      const tenToEleven = await create({
        calculation: 'checks',
        businessHours: hours('10:00', '11:00'),
      })
      const [a, b] = await targetStatuses(payload, [afternoon, tenToEleven], new Date(month.to - 1))
      // Day 3's failures happened at 10:00: the afternoon saw none.
      expect(a.attainment.uptime).toBe(1)
      // Other days have no hourly buckets: an hour is 1/24 of their 1440 checks.
      expect(b.attainment.uptime).toBeCloseTo((60 * days - 20) / (60 * days), 9)

      const data = await buildSlaReport(
        payload,
        { ...report, targets: [afternoon.id] } as SlaReport,
        month,
        now,
      )
      expect(data.rows[0].businessHours).toBe(true)
      for (const target of [afternoon, tenToEleven]) {
        await payload.delete({ collection: 'sla-targets', id: target.id })
      }
    })

    it('skips holidays and refuses unusable calendars', async () => {
      const holidays = Array.from({ length: days }, (_, i) => at(i + 1).slice(0, 10))
      const target = await create({
        calculation: 'duration',
        businessHours: { ...hours('09:00', '17:00'), holidays: [{ date: holidays[2] }] },
      })
      const [status] = await targetStatuses(payload, [target], new Date(month.to - 1))
      // Day 3, the day of the outage, is a holiday.
      expect(status.attainment.uptime).toBe(1)
      expect(status.attainment.budgetSeconds).toBeCloseTo(0.001 * (days - 1) * 8 * 3600, 3)

      for (const bad of [
        hours('17:00', '09:00'),
        { ...hours('09:00', '17:00'), days: [] },
        { ...hours('09:00', '17:00'), holidays: [{ date: '2026-02-30' }] },
        hours('9am', '17:00'),
      ]) {
        await expect(create({ calculation: 'duration', businessHours: bad })).rejects.toThrow()
      }
    })
  })

  describe('organization time zone (#274)', () => {
    afterAll(async () => {
      await payload.update({
        collection: 'organizations',
        id: org.id,
        data: { settings: { timezone: 'UTC', weekStart: 'monday' } },
      })
    })

    it('cuts report ranges and schedules at local midnight', async () => {
      await payload.update({
        collection: 'organizations',
        id: org.id,
        data: { settings: { timezone: 'Asia/Tokyo', weekStart: 'monday' } },
      })
      const tokyo = { timeZone: 'Asia/Tokyo', weekStart: 'monday' as const }
      const local = periodFromDates(range.from, range.to, tokyo)!
      expect(local.from).toBe(month.from - 9 * HOUR)

      const data = await buildSlaReport(
        payload,
        { ...report, targets: [durationTarget.id] } as SlaReport,
        local,
        now,
      )
      expect([data.from, data.to, data.timeZone]).toEqual([range.from, range.to, 'Asia/Tokyo'])
      // The nine hours before the first UTC day have no statistics, so they are not known.
      expect(data.rows[0].uptime).toBeCloseTo(1 - 1200 / (monthSeconds - 9 * 3600), 9)
      expect(data.rows[0].budgetSeconds).toBeCloseTo(0.001 * monthSeconds, 3)

      // The month is complete in Tokyo at 00:40 local on the 1st, still the 31st in UTC.
      await payload.update({
        collection: 'sla-reports',
        id: report.id,
        data: { lastSentPeriod: 'earlier' },
        overrideAccess: true,
      })
      const jobs: SlaJob[] = []
      setSlaJobSink(async (batch) => void jobs.push(...batch))
      await enqueueDueSlaReports(payload, new Date(month.to - 9 * HOUR + 40 * MIN))
      const mine = jobs.filter((job) => job.data.reportId === String(report.id))
      expect(mine.map((job) => [job.data.period, job.data.from])).toEqual([
        [month.key, month.from - 9 * HOUR],
      ])
    })
  })

  describe('send now (#274)', () => {
    const sendPath = () => `/api/orgs/${org.id}/sla/reports/${report.id}/send`
    const params = () => ({ orgId: String(org.id), id: String(report.id) })
    const post = (token: string, body: unknown) =>
      call(sendRoute, sendPath(), params(), token, { method: 'POST', body: JSON.stringify(body) })

    it('emails a test to the caller or the report to its recipients, leaving the schedule', async () => {
      await payload.update({
        collection: 'sla-reports',
        id: report.id,
        data: { lastSentPeriod: 'earlier' },
        overrideAccess: true,
      })
      const sendEmail = vi.spyOn(payload, 'sendEmail').mockResolvedValue(undefined as never)
      try {
        expect((await post(tokens.viewer, { test: true })).status).toBe(403)
        expect((await post(tokens.outsider, { test: true })).status).toBe(403)
        expect((await post(tokens.owner, { from: '2026-02-31', to: range.to })).status).toBe(400)

        const test = await post(tokens.owner, { test: true, ...range })
        expect(test.status).toBe(200)
        expect(await test.json()).toMatchObject({ sent: 1, test: true, ...range })
        expect(sendEmail.mock.calls.map(([message]) => message.to)).toEqual([owner.email])

        const all = await post(tokens.owner, {})
        expect(all.status).toBe(200)
        // Default range: the schedule's last complete period.
        expect(await all.json()).toMatchObject({ sent: 2, test: false })
        expect(sendEmail.mock.calls.slice(1).map(([message]) => message.to)).toEqual([
          'a@example.com',
          'b@example.com',
        ])
        const after = await payload.findByID({ collection: 'sla-reports', id: report.id })
        expect(after.lastSentPeriod).toBe('earlier')
        expect(after.lastSentAt).toBeTruthy()
      } finally {
        sendEmail.mockRestore()
      }
    })

    it('needs recipients to send to', async () => {
      const bare = (await payload.create({
        collection: 'sla-reports',
        data: { organization: org.id, name: 'No recipients', targets: [durationTarget.id] },
        overrideAccess: true,
      } as never)) as SlaReport
      const res = await call(
        sendRoute,
        `/api/orgs/${org.id}/sla/reports/${bare.id}/send`,
        { orgId: String(org.id), id: String(bare.id) },
        tokens.owner,
        { method: 'POST', body: '{}' },
      )
      expect(res.status).toBe(400)
      await payload.delete({ collection: 'sla-reports', id: bare.id })
    })
  })

  describe('status page components and groups (#274)', () => {
    let page: StatusPage
    let monitorRow: string
    let staticRow: string
    let groupId: string
    const create = (data: Record<string, unknown>) =>
      payload.create({
        collection: 'sla-targets',
        data: {
          organization: org.id,
          target: 99.9,
          period: 'month',
          excludeMaintenance: false,
          calculation: 'duration',
          ...data,
        },
        user: asUser(owner),
        overrideAccess: false,
      } as never) as Promise<SlaTarget>

    beforeAll(async () => {
      page = (await payload.create({
        collection: 'status-pages',
        data: {
          organization: org.id,
          title: 'Acme Status',
          slug: `sla-page-${run}`,
          published: true,
          groups: [
            {
              name: 'Core',
              monitors: [{ monitor: monitor.id }, { type: 'static', name: 'Support desk' }],
            },
          ],
        },
        depth: 0,
      })) as StatusPage
      await payload.db.updateOne({
        collection: 'status-pages',
        id: page.id,
        data: { createdAt: new Date(month.from - 30 * DAY).toISOString() },
        req: {} as never,
      })
      page = (await payload.findByID({
        collection: 'status-pages',
        id: page.id,
        depth: 0,
      })) as StatusPage
      monitorRow = String(page.groups?.[0]?.monitors?.[0]?.id)
      staticRow = String(page.groups?.[0]?.monitors?.[1]?.id)
      groupId = String(page.groups?.[0]?.id)
      // The support desk: a major outage for an hour on day 10, a partial one for two on day 12.
      for (const [day, hours, impact] of [
        [10, 1, 'major_outage'],
        [12, 2, 'partial_outage'],
      ] as const) {
        await payload.create({
          collection: 'incidents',
          data: {
            statusPage: page.id,
            title: `Support ${impact}`,
            updates: [
              {
                status: 'investigating',
                message: 'Down.',
                postedAt: at(day),
                components: [{ component: staticRow, impact }],
              },
              { status: 'resolved', message: 'Fixed.', postedAt: at(day, hours * HOUR) },
            ],
          } as RequiredDataFromCollectionSlug<'incidents'>,
          overrideAccess: true,
        })
      }
    })

    it('measures a monitor component from its monitor and a static one from incident impacts', async () => {
      const monitorComponent = await create({
        subject: 'component',
        statusPage: page.id,
        component: monitorRow,
      })
      const staticComponent = await create({
        subject: 'component',
        statusPage: page.id,
        component: staticRow,
      })
      const [a, b] = await targetStatuses(
        payload,
        [monitorComponent, staticComponent],
        new Date(month.to - 1),
      )
      expect(a.name).toBe('Acme Status › Checkout API')
      expect(a.subject).toBe('component')
      expect(a.attainment.uptime).toBeCloseTo(1 - 1200 / monthSeconds, 9)
      expect(a.incidents.map((i) => [i.source, i.cause])).toEqual([
        ['monitor', 'Connection refused'],
      ])
      // One hour down plus two hours half down.
      expect(b.name).toBe('Acme Status › Support desk')
      expect(b.attainment.uptime).toBeCloseTo(1 - 7200 / monthSeconds, 9)
      expect(b.attainment.remainingSeconds).toBeCloseTo(0.001 * monthSeconds - 7200, 3)
      expect(b.incidents.map((i) => i.source)).toEqual(['statusPage', 'statusPage'])
      expect(b.incidents[0].statusPageId).toBe(String(page.id))
    })

    it('measures a group as the mean of its components, under any calculation mode', async () => {
      const duration = await create({ subject: 'group', statusPage: page.id, component: groupId })
      const manual = await create({
        subject: 'group',
        statusPage: page.id,
        component: groupId,
        calculation: 'manual',
      })
      const [a, b] = await targetStatuses(payload, [duration, manual], new Date(month.to - 1))
      expect(a.name).toBe('Acme Status › Core')
      expect(a.attainment.uptime).toBeCloseTo(1 - (1200 + 7200) / 2 / monthSeconds, 9)
      expect(a.attainment.budgetSeconds).toBeCloseTo(0.001 * monthSeconds, 3)
      expect(a.attainment.remainingSeconds).toBeCloseTo(0.001 * monthSeconds - 4200, 3)
      // Incident impacts only: the monitor component had none.
      expect(b.attainment.uptime).toBeCloseTo(1 - 7200 / 2 / monthSeconds, 9)

      const data = await buildSlaReport(
        payload,
        { ...report, targets: [duration.id] } as SlaReport,
        month,
        now,
      )
      expect(data.rows.map((row) => [row.name, row.incidents])).toEqual([['Acme Status › Core', 3]])
    })

    it('refuses components of other pages, unknown rows and incident impacts on monitors', async () => {
      const foreignPage = (await payload.create({
        collection: 'status-pages',
        data: {
          organization: otherOrg.id,
          title: 'Other',
          slug: `sla-other-page-${run}`,
          groups: [{ name: 'G', monitors: [{ type: 'static', name: 'S' }] }],
        },
        depth: 0,
      })) as StatusPage
      for (const data of [
        { subject: 'group', statusPage: foreignPage.id, component: foreignPage.groups?.[0]?.id },
        { subject: 'component', statusPage: page.id, component: 'nope' },
        { subject: 'component', statusPage: page.id, component: groupId },
        { subject: 'group', statusPage: page.id, component: staticRow },
        { subject: 'monitor', monitor: monitor.id, calculation: 'manual' },
      ]) {
        await expect(create(data)).rejects.toThrow()
      }
      await payload.delete({ collection: 'status-pages', id: foreignPage.id })
    })

    it('drops the targets of a deleted status page', async () => {
      const target = await create({
        subject: 'component',
        statusPage: page.id,
        component: staticRow,
      })
      await payload.delete({ collection: 'incidents', where: { statusPage: { equals: page.id } } })
      await payload.delete({ collection: 'status-pages', id: page.id })
      const { totalDocs } = await payload.find({
        collection: 'sla-targets',
        where: { id: { equals: target.id } },
      })
      expect(totalDocs).toBe(0)
    })
  })

  describe('error budget alerts (#274)', () => {
    let channel: Notification
    let target: SlaTarget
    const budgetJobs: SlaBudgetJob[] = []

    beforeAll(async () => {
      channel = (await payload.create({
        collection: 'notifications',
        depth: 0,
        overrideAccess: true,
        data: {
          organization: org.id,
          name: 'sla-room',
          type: 'discord',
          config: {
            webhookUrl: 'https://discord.com/api/webhooks/1/test',
            messageFormat: 'custom',
            messageTemplate: '{{ msg }}',
          },
          active: true,
        } as never,
      })) as Notification
      setSlaBudgetJobSink(async (jobs) => void budgetJobs.push(...jobs))
    })

    afterAll(async () => {
      setSlaBudgetJobSink(null)
      vi.unstubAllGlobals()
    })

    it('refuses channels of other organizations', async () => {
      const foreign = (await payload.create({
        collection: 'notifications',
        depth: 0,
        overrideAccess: true,
        data: {
          organization: otherOrg.id,
          name: 'foreign',
          type: 'discord',
          config: { webhookUrl: 'https://discord.com/api/webhooks/2/test' },
          active: true,
        } as never,
      })) as Notification
      await expect(
        payload.create({
          collection: 'sla-targets',
          data: {
            organization: org.id,
            monitor: monitor.id,
            target: 99.9,
            budgetAlerts: { thresholds: [50], notifications: [foreign.id] },
          },
          user: asUser(owner),
          overrideAccess: false,
        } as never),
      ).rejects.toThrow()
    })

    it('notifies once per period and threshold when the budget drops below it', async () => {
      target = (await payload.create({
        collection: 'sla-targets',
        data: {
          organization: org.id,
          monitor: monitor.id,
          target: 99.9,
          period: 'month',
          calculation: 'duration',
          excludeMaintenance: false,
          budgetAlerts: { thresholds: [50, 90, 90, 150], notifications: [channel.id] },
        },
        user: asUser(owner),
        overrideAccess: false,
      } as never)) as SlaTarget
      expect(target.budgetAlerts?.thresholds).toEqual([90, 50])

      const end = new Date(month.to - 1)
      await checkSlaBudgets(payload, end)
      // About 55 % of the budget is left: below 90 %, not below 50 %.
      const mine = () => budgetJobs.filter((job) => job.data.targetId === String(target.id))
      expect(mine().map((job) => [job.data.threshold, job.data.notificationId])).toEqual([
        [90, String(channel.id)],
      ])
      await checkSlaBudgets(payload, end)
      expect(mine()).toHaveLength(1)

      // A stricter target spends the whole budget: one alert, for the lowest threshold crossed.
      await payload.update({
        collection: 'sla-targets',
        id: target.id,
        data: { target: 99.96 },
        overrideAccess: true,
      })
      await checkSlaBudgets(payload, end)
      expect(mine().map((job) => job.data.threshold)).toEqual([90, 50])
      const stored = await payload.findByID({ collection: 'sla-targets', id: target.id })
      expect(stored.budgetAlertState).toEqual({ period: month.key, sent: [90, 50] })

      const calls: { content: string }[] = []
      vi.stubGlobal(
        'fetch',
        vi.fn(async (_url: string, init?: RequestInit) => {
          calls.push(JSON.parse(String(init?.body)) as { content: string })
          return new Response('{}', { status: 200 })
        }),
      )
      expect(await processSlaBudgetAlertJob(payload, mine()[1])).toBe('sent')
      expect(calls[0].content).toMatch(
        /^\[Checkout API\] \[📉 Error budget\] The error budget of [\d.,]+ min is spent \(target 99\.96/,
      )
    })

    it('starts every period with no alert sent', async () => {
      await payload.update({
        collection: 'sla-targets',
        id: target.id,
        data: { budgetAlertState: { period: 'earlier', sent: [90, 50] } },
        overrideAccess: true,
      })
      budgetJobs.length = 0
      await checkSlaBudgets(payload, new Date(month.to - 1))
      expect(
        budgetJobs
          .filter((job) => job.data.targetId === String(target.id))
          .map((j) => j.data.threshold),
      ).toEqual([50])
    })
  })

  it('drops a deleted target from its reports and a deleted monitor’s targets', async () => {
    await payload.delete({
      collection: 'sla-targets',
      id: checksTarget.id,
      user: asUser(owner),
      overrideAccess: false,
    })
    const after = await payload.findByID({ collection: 'sla-reports', id: report.id, depth: 0 })
    expect((after.targets ?? []).map(String)).toEqual([String(durationTarget.id)])

    await payload.delete({ collection: 'monitors', id: monitor.id })
    const { totalDocs } = await payload.find({
      collection: 'sla-targets',
      where: { monitor: { equals: monitor.id } },
    })
    expect(totalDocs).toBe(0)
  })
})
