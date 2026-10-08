/**
 * Probe agent entrypoint (#91): `MARMOT_ROLE=probe` with `MARMOT_URL` and `MARMOT_PROBE_TOKEN`.
 * Needs no database, Redis or Payload secret: it talks to Marmot over HTTPS only. Run with
 * `pnpm dev:probe` or, in the image, `node dist/server/probe.mjs` (`docker/entrypoint.sh`).
 */
import 'dotenv/config'
import os from 'node:os'

import pkg from '../package.json' with { type: 'json' }
import { env } from '@/env'
import { childLogger } from '@/lib/logger'
import { ProbeAgent } from '@/probe/agent'
import { listMonitorTypes } from '@/server/monitor-types'

const log = childLogger('probe')

async function main() {
  if (env.MARMOT_ROLE !== 'probe') {
    throw new Error(`MARMOT_ROLE must be "probe" to run the probe agent (got "${env.MARMOT_ROLE}")`)
  }
  const agent = new ProbeAgent({
    url: env.MARMOT_URL!,
    token: env.MARMOT_PROBE_TOKEN!,
    version: pkg.version,
    concurrency: env.WORKER_CONCURRENCY,
    hostname: os.hostname(),
    platform: `${process.platform}-${process.arch}`,
  })
  log.info(
    { url: env.MARMOT_URL, version: pkg.version, monitorTypes: listMonitorTypes().length },
    'probe agent starting',
  )
  await agent.start()

  // The agent's timers do not hold the event loop open; this does, until a shutdown signal.
  const keepAlive = setInterval(() => undefined, 1 << 30)
  await new Promise<void>((resolve) => {
    let stopping = false
    const shutdown = async (signal: string) => {
      if (stopping) return
      stopping = true
      log.info({ signal }, 'probe agent shutting down')
      const timer = setTimeout(() => process.exit(1), 15_000)
      try {
        await agent.stop()
      } finally {
        clearTimeout(timer)
        clearInterval(keepAlive)
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
  log.fatal(err, 'probe agent failed to start')
  process.exit(1)
}
