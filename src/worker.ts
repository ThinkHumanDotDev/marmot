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
import { registerStatsListener } from '@/server/stats'

const log = childLogger('worker')

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

  await resyncAll(payload)
  const checkWorker = startCheckWorker(payload)

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
        await checkWorker.close()
        await closeChecksQueue()
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
