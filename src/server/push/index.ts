/**
 * Push monitors: `ALL /api/push/:token?status=up|down&msg=&ping=`.
 *
 * The web process records the beat synchronously through the engine (`recordExternalBeat`), so the
 * same heartbeat listeners that run in the worker — stats rollups, realtime emitter, notification
 * dispatch — fire here too. They are registered lazily on the first push (`ensureBeatPipeline`);
 * all three are Redis publishers or plain database writers, nothing in the web process consumes
 * queues.
 *
 * Port of the `/api/push/:pushToken` handler in Uptime Kuma 2.5.5 `server/routers/api-router.js`
 * (MIT, Louis Lam).
 */
import type { Payload } from 'payload'

import { childLogger } from '@/lib/logger'
import type { Heartbeat, Monitor } from '@/payload-types'
import { recordExternalBeat } from '@/server/engine/worker'
import { registerNotificationListener } from '@/server/notifications'
import { registerRealtimeListener } from '@/server/realtime/listener'
import { registerStatsListener } from '@/server/stats'

const log = childLogger('push')

/** Kuma: 100 billion ms (~3.17 years) fits every column type it supports. */
export const MAX_PING_MS = 100_000_000_000

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
  registerNotificationListener(payload)
}

/** Tests: forget that the pipeline was registered (listeners themselves are cleared elsewhere). */
export function resetBeatPipeline(): void {
  pipelineReady = false
}

export interface PushQuery {
  status?: string | null
  msg?: string | null
  ping?: string | null
}

export type PushOutcome =
  | { ok: true; heartbeat: Heartbeat; monitor: Monitor }
  | { ok: false; status: 400 | 404; msg: string }

/** Parse and validate the query string the way Kuma does (`status` defaults to `up`). */
export function parsePushQuery(
  query: PushQuery,
): { status: 'up' | 'down'; msg: string; ping: number | null } | { error: string } {
  const status = (query.status ?? 'up').toLowerCase() === 'up' ? 'up' : 'down'
  const msg = (query.msg ?? '').slice(0, 250) || 'OK'
  let ping: number | null = null
  if (query.ping !== undefined && query.ping !== null && query.ping !== '') {
    ping = Number.parseFloat(query.ping)
    if (!Number.isFinite(ping)) ping = null
    else if (ping < 0 || ping > MAX_PING_MS) {
      return { error: `Invalid ping value. Must be between 0 and ${MAX_PING_MS} ms.` }
    }
  }
  return { status, msg, ping }
}

/** Find the active push monitor addressed by `token`, or `null`. */
export async function findPushMonitor(payload: Payload, token: string): Promise<Monitor | null> {
  if (!token || token.length > 128) return null
  const { docs } = await payload.find({
    collection: 'monitors',
    where: {
      and: [
        { pushToken: { equals: token } },
        { type: { equals: 'push' } },
        { active: { equals: true } },
      ],
    },
    depth: 0,
    limit: 1,
    overrideAccess: true,
  })
  return (docs[0] as Monitor | undefined) ?? null
}

/** Handle one push call. Unknown or paused tokens are a 404, like Kuma. */
export async function handlePush(
  payload: Payload,
  token: string,
  query: PushQuery,
): Promise<PushOutcome> {
  const parsed = parsePushQuery(query)
  if ('error' in parsed) return { ok: false, status: 400, msg: parsed.error }

  const monitor = await findPushMonitor(payload, token)
  if (!monitor) return { ok: false, status: 404, msg: 'Monitor not found or not active.' }

  ensureBeatPipeline(payload)
  const { heartbeat, monitor: updated } = await recordExternalBeat(payload, monitor, parsed)
  log.debug({ monitorId: monitor.id, status: heartbeat.status }, 'push received')
  return { ok: true, heartbeat, monitor: updated }
}
