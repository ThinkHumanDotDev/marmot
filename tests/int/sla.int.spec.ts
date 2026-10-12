/**
 * SLA targets, reports, share links and scheduled reports (#156).
 *
 * Fixture: one monitor observed over the whole previous calendar month (UTC), DOWN for 20 minutes
 * on day 3 and in maintenance for two hours on day 5; 20 failed and 120 maintenance checks.
 */
import { getPayload, type Payload } from 'payload'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import config from '@payload-config'
import { GET as reportRoute } from '@/app/api/orgs/[orgId]/sla/reports/[id]/route'
import { DELETE as revokeRoute } from '@/app/api/orgs/[orgId]/sla/reports/[id]/shares/[shareId]/route'
import {
  GET as sharesListRoute,
  POST as sharesRoute,
} from '@/app/api/orgs/[orgId]/sla/reports/[id]/shares/route'
import { GET as targetsRoute } from '@/app/api/orgs/[orgId]/sla/targets/route'
import { GET as publicRoute } from '@/app/api/sla/[token]/route'
import { periodDates, previousSchedulePeriod, type SlaReportData } from '@/lib/sla'
import type { Monitor, Organization, SlaReport, SlaTarget, User } from '@/payload-types'
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
      expect(Object.keys(data).sort()).toEqual(['from', 'generatedAt', 'name', 'rows', 'to'])
      expect(data.name).toBe('Customer SLA')
      expect([data.from, data.to]).toEqual([range.from, range.to])
      expect(data.rows.map((r) => r.name)).toEqual(['Checkout API', 'Checkout API'])
      const csv = await call(publicRoute, `/api/sla/${token}?format=csv`, { token })
      expect(csv.status).toBe(200)

      for (const guess of ['x'.repeat(43), 'short', `${token.slice(0, -1)}A`]) {
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
