/**
 * Open tickets of issue-tracker channels (#149), backed by the `notification-sent-history`
 * collection: one `issue` row per monitor, channel and target (repository, project or team) while
 * an outage is open. The DOWN alert stores the ticket, reminders comment on it and the recovery
 * closes it and deletes the row, so every outage maps to exactly one issue.
 */
import type { Payload, Where } from 'payload'

import { childLogger } from '@/lib/logger'
import type { IssueStateStore } from '@/server/notification-providers/types'

const log = childLogger('notifications:issues')

/** `fingerprint` of a channel's row for one target: `<channel id>:<target>`. */
export const issueFingerprint = (channelId: string | number, target: string) =>
  `${String(channelId)}:${target}`

export interface IssueStateScope {
  channelId: string | number
  monitorId: string | number
  organizationId?: string | number | null
}

/** Database-backed store used by the worker. Rows are written with `overrideAccess`. */
export function createPayloadIssueState(payload: Payload, scope: IssueStateScope): IssueStateStore {
  const where = (target: string): Where => ({
    and: [
      { type: { equals: 'issue' } },
      { monitor: { equals: scope.monitorId } },
      { fingerprint: { equals: issueFingerprint(scope.channelId, target) } },
    ],
  })

  const find = async (target: string) => {
    const { docs } = await payload.find({
      collection: 'notification-sent-history',
      where: where(target),
      limit: 1,
      depth: 0,
      overrideAccess: true,
    })
    return docs[0] ?? null
  }

  return {
    async get(target) {
      const row = await find(target)
      return row?.externalId ? String(row.externalId) : null
    },
    async set(target, externalId) {
      const existing = await find(target)
      if (existing) {
        await payload.update({
          collection: 'notification-sent-history',
          id: existing.id,
          depth: 0,
          overrideAccess: true,
          data: { externalId },
        })
        return
      }
      try {
        await payload.create({
          collection: 'notification-sent-history',
          depth: 0,
          overrideAccess: true,
          data: {
            type: 'issue',
            monitor: scope.monitorId,
            days: 0,
            fingerprint: issueFingerprint(scope.channelId, target),
            externalId,
            organization: scope.organizationId ?? null,
          } as never,
        })
      } catch (err) {
        // The compound unique index rejects a concurrent duplicate; keep the newer ticket.
        log.debug({ err, ...scope, target }, 'issue row already exists; updating it')
        const row = await find(target)
        if (!row) throw err
        await payload.update({
          collection: 'notification-sent-history',
          id: row.id,
          depth: 0,
          overrideAccess: true,
          data: { externalId },
        })
      }
    },
    async clear(target) {
      await payload.delete({
        collection: 'notification-sent-history',
        where: where(target),
        depth: 0,
        overrideAccess: true,
      })
    },
  }
}

/** In-memory store for unit tests. */
export function createMemoryIssueState(): IssueStateStore & { rows: Map<string, string> } {
  const rows = new Map<string, string>()
  return {
    rows,
    async get(target) {
      return rows.get(target) ?? null
    },
    async set(target, externalId) {
      rows.set(target, externalId)
    },
    async clear(target) {
      rows.delete(target)
    },
  }
}
