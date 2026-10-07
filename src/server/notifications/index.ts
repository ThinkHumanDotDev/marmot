/**
 * Notification pipeline.
 *
 * heartbeat (engine) ─▶ `registerNotificationListener` ─▶ `enqueueNotificationsForHeartbeat`
 *   ─▶ BullMQ `marmot:notifications` (one job per channel, id `notif:<channel>:<heartbeat>`)
 *   ─▶ `startNotificationWorker` ─▶ `processNotificationJob` ─▶ `sendNotification` ─▶ provider.send()
 *
 * The test endpoint reuses `sendTestNotification` directly (no queue).
 */
import type { Payload } from 'payload'

import { childLogger } from '@/lib/logger'
import { registerHeartbeatListener } from '@/server/engine/hooks'
import { enqueueNotificationsForHeartbeat, type EnqueueOptions } from './dispatch'

export * from './dispatch'
export * from './downtime'
export * from './maintenance'
export * from './message'
export * from './send'
export * from './worker'

const log = childLogger('notifications')

/**
 * Hook the dispatcher into the engine's heartbeat fan-out. Only beats the state machine flagged
 * with `notify` (status transitions and resend ticks) are enqueued. Returns the unsubscribe function.
 */
export function registerNotificationListener(
  _payload: Payload,
  options: EnqueueOptions = {},
): () => void {
  const unsubscribe = registerHeartbeatListener(async (event) => {
    if (!event.notify) return
    try {
      await enqueueNotificationsForHeartbeat(event, options)
    } catch (err) {
      log.error({ err, monitorId: event.monitor.id }, 'failed to enqueue notifications')
    }
  })
  log.info('notification heartbeat listener registered')
  return unsubscribe
}
