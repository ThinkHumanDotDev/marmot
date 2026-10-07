/**
 * Builder-side plumbing for `/api/orgs/:orgId/status-pages/:id/subscribers/**` and
 * `/api/orgs/:orgId/status-pages/:id/notifications/**`: authentication, the page lookup with the
 * user's access, permission checks and the JSON shapes. Subscriber reads and writes run with the
 * user and `overrideAccess: false`, so the collection's `subscriber:*` access rules apply.
 */

import { canInOrg } from '@/access/overrides'
import type { Permission, UserLike } from '@/access/permissions'
import { maskTarget } from '@/lib/status-page-subscribers'
import type {
  StatusPage,
  StatusPageSubscriber,
  SubscriberDelivery,
  SubscriberNotification,
} from '@/payload-types'
import { errorText } from '@/server/request-locale'
import {
  authenticate,
  coerceId,
  jsonError,
  loadOrgStatusPage,
  type Authenticated,
} from '@/server/status-pages/http'

export interface OwnerContext extends Authenticated {
  page: StatusPage
  orgId: string
}

/**
 * Authenticates, loads the page as the user (404 when it is not in `orgId` or not readable) and
 * checks `permission` in the organization (403).
 */
export async function ownerContext(
  request: Request,
  orgId: string,
  pageId: string,
  permission: Permission,
): Promise<{ ok: true; ctx: OwnerContext } | { ok: false; response: Response }> {
  const auth = await authenticate(request)
  if (!auth.ok) return auth
  const page = await loadOrgStatusPage(auth.ctx, orgId, pageId, 0)
  if (!page) {
    return { ok: false, response: jsonError(errorText(request, 'statusPageNotFound'), 404) }
  }
  const allowed = await canInOrg(
    auth.ctx.payload,
    auth.ctx.user as unknown as UserLike,
    coerceId(auth.ctx.payload, orgId),
    permission,
  )
  if (!allowed) return { ok: false, response: jsonError(errorText(request, 'forbidden'), 403) }
  return { ok: true, ctx: { ...auth.ctx, page, orgId } }
}

/** A subscriber of the page, read as the user; `null` when missing or on another page. */
export async function loadOwnerSubscriber(
  ctx: OwnerContext,
  subscriberId: string,
): Promise<StatusPageSubscriber | null> {
  const { docs } = await ctx.payload.find({
    collection: 'status-page-subscribers',
    where: {
      and: [
        { id: { equals: coerceId(ctx.payload, subscriberId) } },
        { statusPage: { equals: ctx.page.id } },
      ],
    },
    depth: 0,
    limit: 1,
    user: ctx.user,
    overrideAccess: false,
  })
  return (docs[0] as StatusPageSubscriber | undefined) ?? null
}

export async function loadOwnerNotification(
  ctx: OwnerContext,
  notificationId: string,
): Promise<SubscriberNotification | null> {
  const { docs } = await ctx.payload.find({
    collection: 'subscriber-notifications',
    where: {
      and: [
        { id: { equals: coerceId(ctx.payload, notificationId) } },
        { statusPage: { equals: ctx.page.id } },
      ],
    },
    depth: 0,
    limit: 1,
    user: ctx.user,
    overrideAccess: false,
  })
  return (docs[0] as SubscriberNotification | undefined) ?? null
}

/** Subscriber as the builder lists it (`secret` and `headers` only when the user may see them). */
export const ownerSubscriber = (doc: StatusPageSubscriber) => ({
  id: doc.id,
  channel: doc.channel,
  target: doc.target,
  components: doc.components ?? [],
  source: doc.source ?? 'self_signup',
  confirmedAt: doc.confirmedAt ?? null,
  createdAt: doc.createdAt,
  lastDeliveredAt: doc.lastDeliveredAt ?? null,
  lastError: doc.lastError ?? null,
  ...(doc.secret ? { secret: doc.secret } : {}),
  ...(doc.headers ? { headers: doc.headers.map((h) => ({ name: h.name, value: h.value })) } : {}),
})
export type OwnerSubscriber = ReturnType<typeof ownerSubscriber>

export const ownerNotification = (doc: SubscriberNotification) => ({
  id: doc.id,
  event: doc.event,
  state: doc.state,
  title: doc.title,
  status: doc.status ?? null,
  message: doc.message ?? '',
  components: doc.components ?? [],
  occurredAt: doc.occurredAt,
  recipientCount: doc.recipientCount ?? null,
  channels: doc.channels ?? [],
  approvedAt: doc.approvedAt ?? null,
  discardedAt: doc.discardedAt ?? null,
  sendingStartedAt: doc.sendingStartedAt ?? null,
  completedAt: doc.completedAt ?? null,
  createdAt: doc.createdAt,
})
export type OwnerNotification = ReturnType<typeof ownerNotification>

/** One row of the delivery log; addresses are masked (the subscriber list shows them in full). */
export const ownerDelivery = (doc: SubscriberDelivery) => {
  const subscriber = doc.subscriber && typeof doc.subscriber === 'object' ? doc.subscriber : null
  return {
    id: doc.id,
    channel: doc.channel,
    state: doc.state,
    attempts: doc.attempts ?? 0,
    error: doc.error ?? null,
    sentAt: doc.sentAt ?? null,
    updatedAt: doc.updatedAt,
    target: subscriber ? maskTarget(subscriber.channel, subscriber.target) : null,
  }
}
export type OwnerDelivery = ReturnType<typeof ownerDelivery>

// ---------------------------------------------------------------------------------------------
// CSV

const csvCell = (value: string): string =>
  /[",\n\r]/.test(value) || /^[=+\-@]/.test(value)
    ? `"${(/^[=+\-@]/.test(value) ? `'${value}` : value).replace(/"/g, '""')}"`
    : value

/** `channel,target,components,source,confirmed_at`; components are `;`-separated ids. */
export function subscribersToCsv(docs: StatusPageSubscriber[]): string {
  const rows = [['channel', 'target', 'components', 'source', 'confirmed_at']]
  for (const doc of docs) {
    rows.push([
      doc.channel,
      doc.target,
      (doc.components ?? []).join(';'),
      doc.source ?? '',
      doc.confirmedAt ?? '',
    ])
  }
  return `${rows.map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`
}

/** Minimal RFC 4180 parser (quoted cells, doubled quotes, CRLF or LF). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  const input = text.replace(/^﻿/, '')
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]
    if (quoted) {
      if (ch === '"' && input[i + 1] === '"') {
        cell += '"'
        i++
      } else if (ch === '"') quoted = false
      else cell += ch
      continue
    }
    if (ch === '"') quoted = true
    else if (ch === ',') {
      row.push(cell)
      cell = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && input[i + 1] === '\n') i++
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else cell += ch
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell)
    rows.push(row)
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''))
}

export interface CsvSubscriberRow {
  line: number
  channel: string
  target: string
  components: string[]
}

/** Rows of an import file; the header row names the columns (`channel`, `target`, `components`). */
export function csvSubscriberRows(text: string): CsvSubscriberRow[] | null {
  const rows = parseCsv(text)
  if (rows.length === 0) return null
  const header = rows[0].map((h) => h.trim().toLowerCase())
  const channel = header.indexOf('channel')
  const target = header.indexOf('target')
  const components = header.indexOf('components')
  if (channel < 0 || target < 0) return null
  return rows.slice(1).map((row, i) => ({
    line: i + 2,
    channel: (row[channel] ?? '').trim().toLowerCase(),
    target: (row[target] ?? '').trim().replace(/^'(?=[=+\-@])/, ''),
    components:
      components >= 0
        ? (row[components] ?? '')
            .split(/[;|]/)
            .map((c) => c.trim())
            .filter(Boolean)
        : [],
  }))
}

export const MAX_IMPORT_ROWS = 10_000
