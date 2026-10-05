/**
 * Worker entrypoint: BullMQ schedulers/workers and Payload Jobs runner.
 * Run with `pnpm dev:worker` (payload run) or `pnpm start:worker`.
 */
import 'dotenv/config'
import { getPayload } from 'payload'

import config from '@payload-config'
import { childLogger } from '@/lib/logger'
import { registerStatsListener } from '@/server/stats'

const log = childLogger('worker')

async function main() {
  const payload = await getPayload({ config })
  log.info({ adapter: payload.db.name }, 'worker booted; polling engine not yet implemented')

  // Time-series aggregation: records every heartbeat into stat-minutely/hourly/daily.
  // No-op (with a single warning) until the engine's hooks module is present.
  try {
    await registerStatsListener(payload)
  } catch (error) {
    log.error({ err: error }, 'failed to register the stats heartbeat listener')
  }

  const shutdown = async (signal: string) => {
    log.info({ signal }, 'worker shutting down')
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
}

main().catch((err) => {
  log.fatal(err, 'worker failed to start')
  process.exit(1)
})
