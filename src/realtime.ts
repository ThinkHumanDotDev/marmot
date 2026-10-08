/**
 * Realtime entrypoint: socket.io server backed by the Redis adapter.
 * Runs as its own process so the Next.js app can keep `output: 'standalone'`-style builds.
 * Run with `pnpm dev:realtime` or `pnpm start:realtime` (both use `scripts/run-ts.mjs`).
 */
import 'dotenv/config'
import { createServer } from 'http'
import { createAdapter } from '@socket.io/redis-adapter'
import { getPayload } from 'payload'

import config from '@payload-config'
import { env } from '@/env'
import { MARMOT_VERSION } from '@/lib/version'
import { childLogger } from '@/lib/logger'
import { createRealtimeServer } from '@/server/realtime/server'
import { createRedis } from '@/server/redis'

const log = childLogger('realtime')

async function main() {
  const httpServer = createServer((req, res) => {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
      return
    }
    res.writeHead(404)
    res.end()
  })

  // Payload is needed to authenticate sockets and to load the initial state of each organization.
  const payload = await getPayload({ config })

  const pub = createRedis()
  const sub = pub.duplicate()

  const io = createRealtimeServer({
    payload,
    httpServer,
    cors: { origin: env.NEXT_PUBLIC_SERVER_URL, credentials: true },
    adapter: createAdapter(pub, sub),
    version: MARMOT_VERSION,
  })

  httpServer.listen(env.REALTIME_PORT, () => {
    log.info({ port: env.REALTIME_PORT, adapter: payload.db.name }, 'realtime server listening')
  })

  let stopping = false
  const shutdown = async (signal: string) => {
    if (stopping) return
    stopping = true
    log.info({ signal }, 'realtime shutting down')
    const timer = setTimeout(() => {
      log.warn('shutdown timed out; exiting')
      process.exit(1)
    }, 10_000)
    try {
      await io.close()
      pub.disconnect()
      sub.disconnect()
      await payload.db.destroy?.()
    } catch (err) {
      log.error({ err }, 'error during shutdown')
    } finally {
      clearTimeout(timer)
      process.exit(0)
    }
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
}

main().catch((err) => {
  log.fatal(err, 'realtime failed to start')
  process.exit(1)
})
