/**
 * Heartbeat listeners of the web process. The push endpoint records beats synchronously through the
 * engine, so the listeners the worker registers at boot (stats rollups, realtime emitter, monitor
 * incidents, notification dispatch) are registered lazily on the first push signal.
 */
import type { Payload } from 'payload'

import { childLogger } from '@/lib/logger'
import { registerIncidentListener } from '@/server/incidents/listener'
import { registerNotificationListener } from '@/server/notifications'
import { registerRealtimeListener } from '@/server/realtime/listener'
import { registerStatsListener } from '@/server/stats'

const log = childLogger('push')

let pipelineReady = false

/**
 * Register the heartbeat listeners once per process. The worker registers the same set at boot;
 * calling this there is harmless (each listener guards against double registration or is cheap).
 */
export function ensureBeatPipeline(payload: Payload): void {
  if (pipelineReady) return
  pipelineReady = true
  void registerStatsListener(payload).catch((err: unknown) =>
    log.error({ err }, 'failed to register the stats listener'),
  )
  registerRealtimeListener()
  // Before notifications, so a DOWN alert can link to its incident.
  registerIncidentListener(payload)
  registerNotificationListener(payload)
}

/** Tests: forget that the pipeline was registered (listeners themselves are cleared elsewhere). */
export function resetBeatPipeline(): void {
  pipelineReady = false
}
