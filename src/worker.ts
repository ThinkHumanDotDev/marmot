/**
 * Worker entrypoint: BullMQ schedulers/workers and background jobs.
 * Run with `pnpm dev:worker` or `pnpm start:worker` (both use `scripts/run-ts.mjs`).
 */
import 'dotenv/config'
import { getPayload } from 'payload'

import config from '@payload-config'
import pkg from '../package.json' with { type: 'json' }
import { childLogger } from '@/lib/logger'
import { captureServerEvent, shutdownServerAnalytics } from '@/server/analytics'
import {
  closeChecksQueue,
  resyncAll,
  setMaintenanceResolver,
  startCheckWorker,
} from '@/server/engine'
import {
  closeMaintenanceQueue,
  createMaintenanceResolver,
  startMaintenanceWorker,
} from '@/server/maintenance'
import { startConnectivityCheck } from '@/server/engine/connectivity-runtime'
import { closeCheckerStateStore } from '@/server/engine/connectivity-state'
import { registerExpiryNotificationListener } from '@/server/jobs/expiry-notifications'
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
  // Opt-in telemetry (docs/Telemetry.md): one aggregate event per worker boot, no identifiers.
  captureServerEvent('instance_started', {
    version: pkg.version,
    adapter: payload.db.name,
    role: 'worker',
    node: process.versions.node,
  })

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

  // Maintenance: monitors inside a running window get MAINTENANCE beats instead of being checked.
  setMaintenanceResolver(createMaintenanceResolver())
  // TLS certificate / domain registration expiry warnings (thresholds from the instance settings).
  registerExpiryNotificationListener(payload)

  // In a composed deployment the web container runs migrations while the worker is already
  // booting, so the schema may not exist yet. Wait for it instead of crash-looping.
  await waitForSchema(() => resyncAll(payload))
  // Self connectivity check (CONNECTIVITY_CHECK_ENABLED): probes before the first check runs.
  const connectivity = await startConnectivityCheck(payload)
  const checkWorker = startCheckWorker(payload)
  const notificationWorker = startNotificationWorker(payload)
  // Recomputes maintenance statuses every minute (and runs retention jobs on the same queue).
  const maintenanceWorker = await startMaintenanceWorker(payload)

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
        await Promise.all([
          checkWorker.close(),
          notificationWorker.close(),
          maintenanceWorker.close(),
        ])
        await connectivity?.stop()
        await Promise.all([closeChecksQueue(), closeNotificationsQueue(), closeMaintenanceQueue()])
        await closeCheckerStateStore()
        await closeEmitter()
        await shutdownServerAnalytics()
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
