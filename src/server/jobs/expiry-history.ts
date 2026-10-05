/**
 * "Already notified" bookkeeping for the TLS certificate and domain expiry warnings, backed by the
 * `notification-sent-history` collection (Uptime Kuma's `notification_sent_history` table).
 *
 * The lookup is `days <= threshold`: once the 14-day warning went out, the 21-day one is considered
 * covered too, so a certificate that is already inside several thresholds triggers one message.
 */
import type { Payload } from 'payload'

import type { ExpiryNotificationType } from '@/collections/NotificationSentHistory'
import { childLogger } from '@/lib/logger'

export type { ExpiryNotificationType }

const log = childLogger('expiry:history')

export interface SentHistoryStore {
  /** Was a warning of `type` for a threshold at or below `days` already sent for the monitor? */
  wasSent(type: ExpiryNotificationType, monitorId: string | number, days: number): Promise<boolean>
  /** Record that the warning for `days` was sent. Idempotent. */
  markSent(type: ExpiryNotificationType, monitorId: string | number, days: number): Promise<void>
  /** Forget every warning of `type` for the monitor (new certificate / renewed domain). */
  clear(type: ExpiryNotificationType, monitorId: string | number): Promise<void>
}

/** Database-backed store used by the worker. `organizationId` is denormalised onto new rows. */
export function createPayloadSentHistory(
  payload: Payload,
  organizationId?: string | number | null,
): SentHistoryStore {
  return {
    async wasSent(type, monitorId, days) {
      const { totalDocs } = await payload.find({
        collection: 'notification-sent-history',
        where: {
          and: [
            { type: { equals: type } },
            { monitor: { equals: monitorId } },
            { days: { less_than_equal: days } },
          ],
        },
        limit: 1,
        depth: 0,
        overrideAccess: true,
      })
      return totalDocs > 0
    },
    async markSent(type, monitorId, days) {
      try {
        await payload.create({
          collection: 'notification-sent-history',
          depth: 0,
          overrideAccess: true,
          data: {
            type,
            monitor: monitorId,
            days,
            organization: organizationId ?? null,
          } as never,
        })
      } catch (err) {
        // The compound unique index rejects a duplicate: another check recorded it first.
        log.debug({ err, type, monitorId, days }, 'sent-history row already exists')
      }
    },
    async clear(type, monitorId) {
      await payload.delete({
        collection: 'notification-sent-history',
        where: { and: [{ type: { equals: type } }, { monitor: { equals: monitorId } }] },
        depth: 0,
        overrideAccess: true,
      })
    },
  }
}

/** In-memory store for unit tests. */
export function createMemorySentHistory(): SentHistoryStore & {
  rows: { type: ExpiryNotificationType; monitorId: string; days: number }[]
} {
  const rows: { type: ExpiryNotificationType; monitorId: string; days: number }[] = []
  return {
    rows,
    async wasSent(type, monitorId, days) {
      return rows.some(
        (r) => r.type === type && r.monitorId === String(monitorId) && r.days <= days,
      )
    },
    async markSent(type, monitorId, days) {
      if (
        !rows.some((r) => r.type === type && r.monitorId === String(monitorId) && r.days === days)
      )
        rows.push({ type, monitorId: String(monitorId), days })
    },
    async clear(type, monitorId) {
      for (let i = rows.length - 1; i >= 0; i -= 1) {
        if (rows[i].type === type && rows[i].monitorId === String(monitorId)) rows.splice(i, 1)
      }
    },
  }
}

/** Thresholds in ascending order so the tightest matching one fires (and covers the looser ones). */
export function sortedThresholds(days: readonly number[]): number[] {
  return [...new Set(days.filter((d) => Number.isFinite(d) && d >= 0))].sort((a, b) => a - b)
}
