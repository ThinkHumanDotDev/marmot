/**
 * HTTP(s) monitor: UP when the response status is in `acceptedStatusCodes`.
 * Ported from the `http` branch of Uptime Kuma 2.5.5 `server/model/monitor.js` (MIT, Louis Lam).
 */
import { performHttpCheck } from './http-request'
import { registerMonitorType } from './registry'

registerMonitorType({
  name: 'http',
  label: 'HTTP(s)',
  group: 'general',
  async check(ctx) {
    await performHttpCheck(ctx)
    ctx.heartbeat.status = 'up'
  },
})
