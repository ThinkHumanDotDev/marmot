/**
 * Public, read-only share links of SLA reports (#156).
 *
 * A link is `/sla/<token>` with 32 random bytes (base64url) as the token. Only its SHA-256 is
 * stored (`sla-report-shares.tokenHash`), so the link is shown once, when it is created. A link
 * names one report and a fixed range of days; it exposes that report's rows and nothing else
 * (monitor names and figures, no ids, targets or URLs of monitors). Revoking stamps `revokedAt`,
 * after which the link resolves to nothing, for good.
 */
import { createHash, randomBytes } from 'node:crypto'

import type { Payload } from 'payload'

import { SLA_SHARE_SERVER_CONTEXT } from '@/collections/Sla'
import { periodFromDates, type SlaPeriod } from '@/lib/sla'
import type { SlaReport, SlaReportShare } from '@/payload-types'
import type { OrgRequestContext } from '@/server/notifications/api'
import { relationId } from '@/server/maintenance/serialize'
import { serverUrl } from '@/server/status-pages/urls'

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/

export const generateShareToken = (): string => randomBytes(32).toString('base64url')

export const hashShareToken = (token: string): string =>
  createHash('sha256').update(token).digest('hex')

export const shareUrl = (token: string): string => `${serverUrl()}/sla/${token}`

export interface ShareRow {
  id: string
  from: string
  to: string
  createdAt: string
  createdBy: string | null
  revokedAt: string | null
}

export const toShareRow = (doc: SlaReportShare): ShareRow => ({
  id: String(doc.id),
  from: doc.fromDate,
  to: doc.toDate,
  createdAt: doc.createdAt,
  createdBy: relationId(doc.createdBy) === null ? null : String(relationId(doc.createdBy)),
  revokedAt: doc.revokedAt ?? null,
})

/** Creates a link for `period` of `report`; the response is the only time the token is seen. */
export async function createShare(
  ctx: OrgRequestContext,
  report: SlaReport,
  period: SlaPeriod,
): Promise<{ share: ShareRow; token: string; url: string }> {
  const token = generateShareToken()
  const from = new Date(period.from).toISOString().slice(0, 10)
  const to = new Date(period.to - 86_400_000).toISOString().slice(0, 10)
  const doc = (await ctx.payload.create({
    collection: 'sla-report-shares',
    data: {
      organization: ctx.orgId as SlaReportShare['organization'],
      report: report.id,
      tokenHash: hashShareToken(token),
      fromDate: from,
      toDate: to,
      createdBy: ctx.user.id,
    },
    depth: 0,
    user: ctx.user,
    overrideAccess: false,
    context: { [SLA_SHARE_SERVER_CONTEXT]: true },
  })) as SlaReportShare
  return { share: toShareRow(doc), token, url: shareUrl(token) }
}

/** Links of a report, newest first (revoked ones included, flagged). */
export async function listShares(ctx: OrgRequestContext, report: SlaReport): Promise<ShareRow[]> {
  const { docs } = await ctx.payload.find({
    collection: 'sla-report-shares',
    where: {
      and: [{ report: { equals: report.id } }, { organization: { equals: ctx.orgId } }],
    },
    sort: '-createdAt',
    depth: 0,
    limit: 200,
    user: ctx.user,
    overrideAccess: false,
  })
  return (docs as SlaReportShare[]).map(toShareRow)
}

/** Revokes one link of the report (as the user). Null when the link is not the report's. */
export async function revokeShare(
  ctx: OrgRequestContext,
  report: SlaReport,
  shareId: string | number,
): Promise<ShareRow | null> {
  const { docs } = await ctx.payload.find({
    collection: 'sla-report-shares',
    where: {
      and: [
        { id: { equals: shareId } },
        { report: { equals: report.id } },
        { organization: { equals: ctx.orgId } },
      ],
    },
    depth: 0,
    limit: 1,
    user: ctx.user,
    overrideAccess: false,
  })
  const share = docs[0] as SlaReportShare | undefined
  if (!share) return null
  if (share.revokedAt) return toShareRow(share)
  const doc = (await ctx.payload.update({
    collection: 'sla-report-shares',
    id: share.id,
    data: { revokedAt: new Date().toISOString() },
    depth: 0,
    user: ctx.user,
    overrideAccess: false,
  })) as SlaReportShare
  return toShareRow(doc)
}

export interface ResolvedShare {
  share: SlaReportShare
  report: SlaReport
  period: SlaPeriod
}

/**
 * The report and range behind a token, or null when the token is malformed, unknown or revoked,
 * or its report is gone. Public path: reads with `overrideAccess`, the token is the credential.
 */
export async function resolveShare(payload: Payload, token: string): Promise<ResolvedShare | null> {
  if (!TOKEN_RE.test(token)) return null
  const { docs } = await payload.find({
    collection: 'sla-report-shares',
    where: { tokenHash: { equals: hashShareToken(token) } },
    depth: 0,
    limit: 1,
    overrideAccess: true,
  })
  const share = docs[0] as SlaReportShare | undefined
  if (!share || share.revokedAt) return null
  const period = periodFromDates(share.fromDate, share.toDate)
  const reportId = relationId(share.report)
  if (!period || reportId === null) return null
  const report = (await payload
    .findByID({ collection: 'sla-reports', id: reportId, depth: 0, overrideAccess: true })
    .catch(() => null)) as SlaReport | null
  if (
    !report ||
    String(relationId(report.organization)) !== String(relationId(share.organization))
  ) {
    return null
  }
  return { share, report, period }
}
