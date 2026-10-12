/**
 * Group monitor: aggregates the cached status of its active children.
 * Ported from Uptime Kuma 2.5.5 `server/monitor-types/group.js` — Copyright (c) 2021 Louis Lam,
 * MIT License. See THIRD_PARTY_NOTICES.md.
 * Marmot additions: a degraded child (and no worse one) makes the group degraded (#93); the
 * `aggregation` setting picks worst (the ported behaviour), quorum or weighted, and
 * `aggregationLatency` derives the group ping from the children (#144, `src/lib/group-aggregation.ts`).
 */
import { aggregateGroup, type ChildStatus } from '@/lib/group-aggregation'

import { registerMonitorType } from './registry'

registerMonitorType({
  name: 'group',
  label: 'Group',
  group: 'general',
  allowCustomStatus: true,
  async check(ctx) {
    const { docs: children } = await ctx.payload.find({
      collection: 'monitors',
      where: { parent: { equals: ctx.monitor.id } },
      depth: 0,
      limit: 0,
      pagination: false,
      overrideAccess: true,
      // A stable order, so the message lists the children the same way on every beat.
      sort: 'name',
      select: { name: true, active: true, status: true, groupWeight: true },
    })

    const verdict = aggregateGroup(
      children.map((child) => ({
        name: child.name || `#${child.id}`,
        active: Boolean(child.active),
        status: (child.status?.lastStatus ?? null) as ChildStatus | null,
        weight: child.groupWeight ?? null,
        ping: child.status?.lastPing ?? null,
      })),
      {
        mode: ctx.monitor.aggregation,
        quorum: ctx.monitor.aggregationQuorum,
        quorumUnit: ctx.monitor.aggregationQuorumUnit,
        latency: ctx.monitor.aggregationLatency,
      },
    )

    if (verdict.ping !== null) ctx.heartbeat.ping = verdict.ping
    // Throw to leverage the generic retry handling and notification flow.
    if (verdict.status === 'down') throw new Error(verdict.msg)
    ctx.heartbeat.status = verdict.status
    ctx.heartbeat.msg = verdict.msg
  },
})
