/**
 * Worker entrypoint: BullMQ schedulers/workers and background jobs.
 * Run with `pnpm dev:worker` or `pnpm start:worker` (both use `scripts/run-ts.mjs`).
 */
import 'dotenv/config'
import { getPayload } from 'payload'

import config from '@payload-config'
import { childLogger } from '@/lib/logger'
import { closeChecksQueue, resyncAll, startCheckWorker } from '@/server/engine'
import { listMonitorTypes } from '@/server/monitor-types'
import {
  closeNotificationsQueue,
  registerNotificationListener,
  startNotificationWorker,
} from '@/server/notifications'
import { closeEmitter } from '@/server/realtime/emitter'
import { registerRealtimeListener } from '@/server/realtime/listener'
import { registerStatsListener } from '@/server/stats'

const log = childLogger('worker')

const SCHEMA_WAIT_MS = Number(process.env.WORKER_SCHEMA_WAIT_MS ?? 120_000)

/** Retries `fn` while the database schema is still being migrated (or the DB is unreachable). */
async function waitForSchema<T>(fn: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + SCHEMA_WAIT_MS
  let attempt = 0
  for (;;) {
    try {
      return await fn()
    } catch (err) {
      attempt += 1
      if (Date.now() >= deadline) throw err
      const message = err instanceof Error ? err.message : String(err)
      log.warn({ attempt, err: message }, 'database not ready yet; retrying in 3s')
      await new Promise((resolve) => setTimeout(resolve, 3_000))
    }
  }
}

async function main() {
  const payload = await getPayload({ config })
  log.info(
    { adapter: payload.db.name, monitorTypes: listMonitorTypes().map((t) => t.name) },
    'worker booted',
  )

  // Time-series aggregation: records every heartbeat into stat-minutely/hourly/daily.
  try {
    await registerStatsListener(payload)
  } catch (error) {
    log.error({ err: error }, 'failed to register the stats heartbeat listener')
  }
  // Realtime: publishes each heartbeat (+ refreshed 24h uptime/avgPing) to the org's socket room.
  // Registered after the stats listener so the figures already include the new beat.
  registerRealtimeListener()

  // Notifications: enqueue one job per attached channel when a beat should notify.
  registerNotificationListener(payload)

  // In a composed deployment the web container runs migrations while the worker is already
  // booting, so the schema may not exist yet. Wait for it instead of crash-looping.
  await waitForSchema(() => resyncAll(payload))
  const checkWorker = startCheckWorker(payload)
  const notificationWorker = startNotificationWorker(payload)

  // Keep the process alive until a shutdown signal arrives.
  await new Promise<void>((resolve) => {
    let stopping = false
    const shutdown = async (signal: string) => {
      if (stopping) return
      stopping = true
      log.info({ signal }, 'worker shutting down')
      const timer = setTimeout(() => {
        log.warn('shutdown timed out; exiting')
        process.exit(1)
      }, 30_000)
      try {
        await Promise.all([checkWorker.close(), notificationWorker.close()])
        await Promise.all([closeChecksQueue(), closeNotificationsQueue()])
        await closeEmitter()
        await payload.db.destroy?.()
      } catch (err) {
        log.error({ err }, 'error during shutdown')
      } finally {
        clearTimeout(timer)
        resolve()
      }
    }
    process.on('SIGINT', () => void shutdown('SIGINT'))
    process.on('SIGTERM', () => void shutdown('SIGTERM'))
  })
}

try {
  await main()
  process.exit(0)
} catch (err) {
  log.fatal(err, 'worker failed to start')
  process.exit(1)
}
