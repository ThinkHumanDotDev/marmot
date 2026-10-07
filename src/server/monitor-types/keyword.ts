/**
 * HTTP(s) keyword monitor: UP when the body contains (or, inverted, lacks) `keyword`.
 * Ported from the `keyword` branch of Uptime Kuma 2.5.5 `server/model/monitor.js` (MIT, Louis Lam).
 * The verdict is also reported as a legacy `textBody` assertion (#96).
 */
import { performHttpCheck, type TypeCheckOutcome } from './http-request'
import { registerMonitorType } from './registry'
import type { MonitorCheckContext } from './types'

export function keywordOutcome(
  monitor: Pick<MonitorCheckContext['monitor'], 'keyword' | 'invertKeyword'>,
  body: string,
  statusMsg: string,
): TypeCheckOutcome {
  const keyword = monitor.keyword ?? ''
  const invert = Boolean(monitor.invertKeyword)

  let data = body
  const keywordFound = data.includes(keyword)
  const passed = keywordFound === !invert
  data = data.replace(/<[^>]*>?|[\n\r]|\s+/gm, ' ').trim()
  if (data.length > 50) {
    data = data.substring(0, 47) + '...'
  }
  return {
    result: {
      kind: 'textBody',
      target: null,
      comparator: invert ? 'not_contains' : 'contains',
      expected: keyword,
      actual: data,
      passed,
    },
    msg: passed
      ? `${statusMsg}, keyword ${keywordFound ? 'is' : 'not'} found`
      : `${statusMsg}, but keyword is ${keywordFound ? 'present' : 'not'} in [${data}]`,
  }
}

registerMonitorType({
  name: 'keyword',
  label: 'HTTP(s) - Keyword',
  group: 'general',
  async check(ctx) {
    await performHttpCheck(ctx, {
      typeCheck: async (res, statusMsg) => keywordOutcome(ctx.monitor, res.body, statusMsg),
    })
    ctx.heartbeat.status = 'up'
  },
})
