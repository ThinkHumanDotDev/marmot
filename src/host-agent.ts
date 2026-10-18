/**
 * Host agent entrypoint (#136): `MARMOT_ROLE=host-agent` with `MARMOT_URL` and `MARMOT_HOST_TOKEN`.
 * Needs no database, Redis or Payload secret and opens no port: it posts a sample of this host's
 * metrics to Marmot every interval. Run with `pnpm dev:host-agent` or, in the image,
 * `node dist/server/host-agent.mjs` (`docker/entrypoint.sh`). The bundle is self-contained, so the
 * same file runs on any machine with Node.js (see docs/Host-Monitoring.md).
 */
import 'dotenv/config'

import pkg from '../package.json' with { type: 'json' }
import { env } from '@/env'
import { HostAgent } from '@/host-agent/agent'
import { HostCollector } from '@/host-agent/collect'
import { defaultDockerSocket } from '@/host-agent/docker'
import { childLogger } from '@/lib/logger'

const log = childLogger('host-agent')

const list = (value: string): string[] =>
  value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)

async function main() {
  if (env.MARMOT_ROLE !== 'host-agent') {
    throw new Error(
      `MARMOT_ROLE must be "host-agent" to run the host agent (got "${env.MARMOT_ROLE}")`,
    )
  }
  const collector = new HostCollector({
    disks: list(env.HOST_AGENT_DISKS),
    root: env.HOST_AGENT_ROOT || undefined,
    agentVersion: pkg.version,
  })
  const agent = new HostAgent({
    url: env.MARMOT_URL!,
    token: env.MARMOT_HOST_TOKEN!,
    version: pkg.version,
    collector,
    interval: env.HOST_AGENT_INTERVAL,
    dockerSocket: env.HOST_AGENT_DOCKER
      ? env.HOST_AGENT_DOCKER_SOCKET || defaultDockerSocket()
      : null,
  })
  log.info(
    { url: env.MARMOT_URL, version: pkg.version, docker: env.HOST_AGENT_DOCKER },
    'host agent starting',
  )
  await agent.start()

  // The agent's timer does not hold the event loop open; this does, until a shutdown signal.
  const keepAlive = setInterval(() => undefined, 1 << 30)
  await new Promise<void>((resolve) => {
    let stopping = false
    const shutdown = async (signal: string) => {
      if (stopping) return
      stopping = true
      log.info({ signal }, 'host agent shutting down')
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
  log.fatal(err, 'host agent failed to start')
  process.exit(1)
}
