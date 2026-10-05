/**
 * Worker-side bridge from the polling engine to the realtime emitter: every heartbeat is
 * published to the monitor's organization room, followed by the refreshed 24h uptime and
 * average ping. Register it AFTER the stats listener so the figures include the new beat.
 */
import { registerHeartbeatListener } from '@/server/engine/hooks'
import { childLogger } from '@/lib/logger'
import { getStats } from '@/server/stats/uptime-calculator'
import { emitAvgPing, emitCertInfo, emitHeartbeat, emitUptime } from './emitter'
import { toRealtimeHeartbeat } from './serialize'

const log = childLogger('realtime:listener')

/** Hook the emitter into the engine; returns the unsubscribe function. */
export function registerRealtimeListener(): () => void {
  return registerHeartbeatListener(async (event) => {
    const organizationId = event.organizationId
    if (organizationId === null || organizationId === undefined) return
    const monitorId = event.monitor.id

    emitHeartbeat(organizationId, { monitorId, heartbeat: toRealtimeHeartbeat(event.heartbeat) })
    if (event.tlsInfo) emitCertInfo(organizationId, monitorId, event.tlsInfo)

    try {
      const stats = await getStats(event.payload, monitorId, '24h')
      emitUptime(organizationId, monitorId, '24h', stats.uptime)
      emitAvgPing(organizationId, monitorId, '24h', stats.avgPing)
    } catch (err) {
      log.error({ err, monitorId }, 'failed to publish uptime after heartbeat')
    }
  })
}
