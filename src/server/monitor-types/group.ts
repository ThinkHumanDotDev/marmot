/**
 * Group monitor: aggregates the cached status of its active children.
 * Ported from Uptime Kuma 2.5.5 `server/monitor-types/group.js` — Copyright (c) 2021 Louis Lam,
 * MIT License. See THIRD_PARTY_NOTICES.md.
 * Marmot addition (#93): a degraded child (and no worse one) makes the group degraded.
 */
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
      select: { name: true, active: true, status: true },
    })

    if (children.length === 0) {
      ctx.heartbeat.status = 'pending'
      ctx.heartbeat.msg = 'Group empty'
      return
    }

    let worstStatus: 'up' | 'degraded' | 'pending' | 'down' = 'up'
    const downChildren: string[] = []
    const pendingChildren: string[] = []
    const degradedChildren: string[] = []

    for (const child of children) {
      if (!child.active) continue // ignore paused children

      const label = child.name || `#${child.id}`
      const lastStatus = child.status?.lastStatus

      if (!lastStatus) {
        if (worstStatus === 'up') worstStatus = 'pending'
        pendingChildren.push(label)
        continue
      }

      if (lastStatus === 'down') {
        worstStatus = 'down'
        downChildren.push(label)
      } else if (lastStatus === 'pending') {
        if (worstStatus !== 'down') worstStatus = 'pending'
        pendingChildren.push(label)
      } else if (lastStatus === 'degraded') {
        if (worstStatus === 'up') worstStatus = 'degraded'
        degradedChildren.push(label)
      }
    }

    if (worstStatus === 'up') {
      ctx.heartbeat.status = 'up'
      ctx.heartbeat.msg = 'All children up and running'
      return
    }

    if (worstStatus === 'degraded') {
      ctx.heartbeat.status = 'degraded'
      ctx.heartbeat.msg = `Degraded child monitors: ${degradedChildren.join(', ')}`
      return
    }

    if (worstStatus === 'pending') {
      ctx.heartbeat.status = 'pending'
      ctx.heartbeat.msg = `Pending child monitors: ${pendingChildren.join(', ')}`
      return
    }

    let message = `Child monitors down: ${downChildren.join(', ')}`
    if (pendingChildren.length > 0) {
      message += `; pending: ${pendingChildren.join(', ')}`
    }
    // Throw to leverage the generic retry handling and notification flow.
    throw new Error(message)
  },
})
