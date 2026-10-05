/**
 * Push monitor (passive): the monitored system calls `/api/push/<pushToken>`; the endpoint records
 * the call in `monitors.status.lastPushAt` (and may write an UP heartbeat itself). This periodic
 * check only verifies that a push arrived within `interval + grace` and goes DOWN otherwise.
 *
 * Inspired by the `push` branch of Uptime Kuma 2.5.5 `server/model/monitor.js` (MIT, Louis Lam).
 */
import { registerMonitorType } from './registry'

/** Allowance for clock drift and scheduler jitter: 10% of the interval, at least 1s. */
export function pushGraceMs(intervalSeconds: number): number {
  return Math.max(1000, Math.round(intervalSeconds * 1000 * 0.1))
}

registerMonitorType({
  name: 'push',
  label: 'Push',
  group: 'passive',
  async check(ctx) {
    const intervalMs = Math.max(1, ctx.monitor.interval) * 1000
    const windowMs = intervalMs + pushGraceMs(ctx.monitor.interval)
    const lastPushAt = ctx.monitor.status?.lastPushAt
      ? new Date(ctx.monitor.status.lastPushAt).getTime()
      : null

    if (lastPushAt === null) {
      ctx.heartbeat.duration = ctx.monitor.interval
      throw new Error('No heartbeat in the time window')
    }

    const msSinceLastPush = Date.now() - lastPushAt
    if (msSinceLastPush > windowMs) {
      ctx.heartbeat.duration = Math.round(msSinceLastPush / 1000)
      throw new Error('No heartbeat in the time window')
    }

    ctx.heartbeat.msg = `Last push ${Math.round(msSinceLastPush / 1000)}s ago`
    ctx.heartbeat.ping = null
    ctx.heartbeat.status = 'up'
  },
})
