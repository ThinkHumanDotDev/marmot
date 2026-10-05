/**
 * Manual monitor: the status is whatever the user set in `manualStatus`.
 * Ported from Uptime Kuma 2.5.5 `server/monitor-types/manual.js` (MIT, Louis Lam).
 */
import { registerMonitorType } from './registry'

registerMonitorType({
  name: 'manual',
  label: 'Manual',
  group: 'passive',
  allowCustomStatus: true,
  async check(ctx) {
    const status = ctx.monitor.manualStatus
    if (status) {
      ctx.heartbeat.status = status
      switch (status) {
        case 'up':
          ctx.heartbeat.msg = 'Up'
          break
        case 'down':
          ctx.heartbeat.msg = 'Down'
          break
        default:
          ctx.heartbeat.msg = 'Pending'
      }
    } else {
      ctx.heartbeat.status = 'pending'
      ctx.heartbeat.msg = 'Manual monitoring - No status set'
    }
  },
})
