/**
 * HTTP(s) keyword monitor: UP when the body contains (or, inverted, lacks) `keyword`.
 * Ported from the `keyword` branch of Uptime Kuma 2.5.5 `server/model/monitor.js` (MIT, Louis Lam).
 */
import { performHttpCheck } from './http-request'
import { registerMonitorType } from './registry'

registerMonitorType({
  name: 'keyword',
  label: 'HTTP(s) - Keyword',
  group: 'general',
  async check(ctx) {
    const res = await performHttpCheck(ctx)
    const keyword = ctx.monitor.keyword ?? ''
    const invert = Boolean(ctx.monitor.invertKeyword)

    let data = res.body
    const keywordFound = data.includes(keyword)
    if (keywordFound === !invert) {
      ctx.heartbeat.msg += `, keyword ${keywordFound ? 'is' : 'not'} found`
      ctx.heartbeat.status = 'up'
      return
    }

    data = data.replace(/<[^>]*>?|[\n\r]|\s+/gm, ' ').trim()
    if (data.length > 50) {
      data = data.substring(0, 47) + '...'
    }
    throw new Error(
      `${ctx.heartbeat.msg}, but keyword is ${keywordFound ? 'present' : 'not'} in [${data}]`,
    )
  },
})
